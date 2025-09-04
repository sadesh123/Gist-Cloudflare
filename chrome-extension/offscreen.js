// Offscreen document script for handling media capture

// Save original console methods first
const originalConsoleLog = console.log;
const originalConsoleError = console.error;
const originalConsoleWarn = console.warn;
const originalConsoleInfo = console.info;
const originalConsoleDebug = console.debug;

// In production, override ALL console methods to prevent logging
console.log = function() {};
console.error = function() {};
console.warn = function() {};
console.info = function() {};
console.debug = function() {};

// Configuration constants
const CONFIG = {
  // Audio processing settings
  AUDIO: {
    MAX_RECORDING_DURATION: 8 * 60 * 1000,  // 8 minutes in milliseconds
    CHUNK_SIZE: 150 * 1024,                 // 150KB chunks for port transfer
    PORT_NAME: 'audio_channel',             // Name for port connection
    CONNECTION_RETRY_DELAY: 1000,           // Delay before retrying connection
    HEARTBEAT_INTERVAL: 2000                // Upload heartbeat interval in ms
  }
};

// Set up a persistent port connection to the background script
let backgroundPort = null;
let pendingChunks = 0;
let uploadComplete = false;

// Try to establish a port connection
function connectToBackground() {
  try {
    backgroundPort = chrome.runtime.connect({ name: CONFIG.AUDIO.PORT_NAME });
    
    // Set up listener for messages from background
    backgroundPort.onMessage.addListener((message) => {
      if (message.type === 'chunk_ack') {
        pendingChunks--;
        if (pendingChunks <= 0) {
          pendingChunks = 0; // Safety check
        }
        
        // If we're done uploading and all chunks are acknowledged, notify completion
        if (uploadComplete && pendingChunks === 0) {
          backgroundPort.postMessage({ 
            type: 'transfer_complete',
            timestamp: new Date().toISOString()
          });
        }
      }
    });
    
    // Set up listener for disconnection
    backgroundPort.onDisconnect.addListener(() => {
      backgroundPort = null;
      // Try to reconnect if we still have pending chunks
      if (pendingChunks > 0) {
        setTimeout(() => {
          connectToBackground();
        }, CONFIG.AUDIO.CONNECTION_RETRY_DELAY);
      }
    });
    
    // Send initial ready message through the port
    backgroundPort.postMessage({ 
      type: 'offscreen_ready',
      timestamp: new Date().toISOString()
    });
  } catch (e) {
    backgroundPort = null;
  }
}

// Connect immediately
connectToBackground();

// Import extendable-media-recorder for WAV support
import { MediaRecorder, register } from 'extendable-media-recorder';
import { connect } from 'extendable-media-recorder-wav-encoder';

// Recording state
let mediaRecorder = null;
let audioChunks = [];
let stream = null;
let recordingStartTime = null;
let audioContext = null;
let wavEncoderRegistered = false;

// Listen for messages from the background script
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Special ping handler to check if offscreen is responsive
  if (request.type === 'PING_OFFSCREEN') {
    sendResponse({ pong: true });
    return true;
  }

  // Make sure we only respond to messages from our own extension's background script
  if (sender.id !== chrome.runtime.id || !sender.url || !sender.url.includes('background')) {
    return false;
  }

  if (request.type === 'START_RECORDING') {
    // Now expect a streamId directly from the background script
    if (!request.streamId) {
      sendResponse({ success: false, status: 'error', error: 'No stream ID provided for recording' });
      return false;
    }

    // clean up any existing recording first
    if (isRecording()) {
      stopRecording()
        .then(() => {
          // Small delay to ensure cleanup
          setTimeout(() => {
            startRecording(request.streamId)
              .then(() => sendResponse({ success: true, status: 'started' }))
              .catch((error) => {
                sendResponse({ success: false, status: 'error', error: error.message });
              });
          }, 500);
        })
        .catch((error) => {
          // Try to start anyway
          startRecording(request.streamId)
            .then(() => sendResponse({ success: true, status: 'started' }))
            .catch((error) => {
              sendResponse({ success: false, status: 'error', error: error.message });
            });
        });
    } else {
      startRecording(request.streamId)
        .then(() => sendResponse({ success: true, status: 'started' }))
        .catch((error) => {
          sendResponse({ success: false, status: 'error', error: error.message });
        });
    }
    return true; // Keep sendResponse valid after the function returns
  }

  if (request.type === 'STOP_RECORDING') {
    stopRecording(request) // Pass the request object to get waitForUpload flag
      .then(() => sendResponse({ success: true, status: 'stopped' }))
      .catch((error) => {
        sendResponse({ success: false, status: 'error', error: error.message });
      });
    return true; // Keep sendResponse valid after the function returns
  }

  if (request.type === 'GET_RECORDING_STATE') {
    sendResponse({ 
      isRecording: isRecording()
    });
    return false; // No async response needed
  }
});

// Check if currently recording
// Check if the tab has audio playing - helps with YouTube detection
async function hasTabAudio() {
  try {
    // Ask background script to check for us
    const response = await chrome.runtime.sendMessage({ 
      type: 'CHECK_TAB_AUDIO'
    });
    
    return response && response.hasAudio;
  } catch (e) {
    return false;
  }
}

function isRecording() {
  return !!mediaRecorder && mediaRecorder.state === 'recording';
}

// Start recording function with provided streamId
async function startRecording(streamId) {
  try {
    // Validate stream ID
    if (!streamId) {
      throw new Error('No stream ID provided for recording');
    }
    
    // Clean up any existing recording
    await cleanupRecording();
    
    // Register WAV encoder if not already registered
    if (!wavEncoderRegistered) {
      try {
        await register(await connect());
        wavEncoderRegistered = true;
      } catch (error) {
        // Continue with default encoder if WAV registration fails
      }
    }
    
    // Use the provided stream ID to capture tab audio
    try {
      // First check if this is YouTube
      const isYouTube = await checkForYouTube();
      if (isYouTube) {
        // Check if audio is actually playing in the tab
        const tabHasAudio = await hasTabAudio();
        
        if (!tabHasAudio) {
          // Send warning to background
          chrome.runtime.sendMessage({ 
            type: 'RECORDING_WARNING', 
            warning: 'No audio detected in YouTube tab. Make sure the video is playing before recording.'
          });
        }
      }
      
      // Using chrome.tabCapture directly instead of getUserMedia
      // This is a promise wrapper around the callback-based chrome.tabCapture.capture
      stream = await new Promise((resolve, reject) => {
        // Try to directly access the tab's stream using the provided stream ID
        try {
          // First try the MediaDevices API with simpler constraints
          navigator.mediaDevices.getUserMedia({
            audio: {
              mandatory: {
                chromeMediaSource: 'tab',
                chromeMediaSourceId: streamId
              }
            },
            video: false  // Explicitly disable video
          }).then(stream => {
            resolve(stream);
          }).catch(err => {
            // If getUserMedia fails, try using tabCapture directly as fallback
            chrome.tabCapture.capture(
              { audio: true, video: false }, 
              function(capturedStream) {
                if (chrome.runtime.lastError) {
                  reject(new Error("Tab capture error: " + chrome.runtime.lastError.message));
                  return;
                }
                
                if (!capturedStream) {
                  reject(new Error("No stream returned from tabCapture"));
                  return;
                }
                
                resolve(capturedStream);
              }
            );
          });
        } catch (e) {
          reject(e);
        }
      });
      
      // Verify the stream has audio tracks
      const audioTracks = stream.getAudioTracks();
      
      if (audioTracks.length === 0) {
        throw new Error('Stream has no audio tracks');
      }
    } catch (error) {
      // Check if this might be a content protection issue
      const isYouTube = await checkForYouTube();
      
      // DOMException objects don't stringify well, extract the message
      let errorMessage;
      if (error.name === 'DOMException') {
        errorMessage = `${error.name}: ${error.message}`;
        
        // Enhanced error for YouTube content protection
        if (isYouTube) {
          errorMessage = 'YouTube Content Protection: This video is preventing audio capture. Try a different video or website.';
        }
      } else {
        errorMessage = 'Error starting tab capture';
      }
        
      throw new Error('Failed to get audio stream: ' + errorMessage);
    }
    
    // Helper function to check if we're on YouTube
    async function checkForYouTube() {
      try {
        // Get current tab info from background
        const tabInfo = await chrome.runtime.sendMessage({ type: 'GET_CURRENT_TAB_INFO' });
        return tabInfo && tabInfo.url && tabInfo.url.includes('youtube.com');
      } catch (e) {
        return false;
      }
    }
    
    if (!stream) {
      throw new Error('Failed to get audio stream');
    }
    
    // Create audio context to route the audio back to speakers
    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      source.connect(audioContext.destination);
    } catch (error) {
      // Try to continue without audio context
    }
    
    // Create a MediaRecorder with WAV format if available, fallback to defaults
    let options = { mimeType: 'audio/wav' };
    try {
      if (wavEncoderRegistered) {
        mediaRecorder = new MediaRecorder(stream, options);
      } else {
        // Fallback to WebM
        options = { mimeType: 'audio/webm' };
        mediaRecorder = new MediaRecorder(stream, options);
      }
    } catch (e) {
      // Try without specific mime type
      try {
        mediaRecorder = new MediaRecorder(stream);
      } catch (e2) {
        throw new Error('MediaRecorder is not supported in this browser');
      }
    }
    
    if (!mediaRecorder) {
      throw new Error('Failed to create MediaRecorder');
    }
    
    audioChunks = [];
    
    // Set up audio chunk handler
    mediaRecorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) {
        audioChunks.push(event.data);
      }
    };
    
    // Handle errors
    mediaRecorder.onerror = (event) => {
      chrome.runtime.sendMessage({ 
        type: 'RECORDING_ERROR', 
        error: event.error?.message || 'Unknown MediaRecorder error'
      });
    };
    
    // Set up recording stop handler
    mediaRecorder.onstop = () => {
      // If we have audio chunks, process them
      if (audioChunks && audioChunks.length > 0) {
        // Determine the correct MIME type based on what we're using
        const mimeType = wavEncoderRegistered ? 'audio/wav' : 'audio/webm';
        
        // Create a Blob from the chunks with the proper MIME type
        const audioBlob = new Blob(audioChunks, { type: mimeType });
        
        if (audioBlob.size > 0) {
          const timestamp = new Date().toISOString();
          const formattedTimestamp = timestamp.replace(/:/g, '-').replace(/\./g, '-');
          const duration = recordingStartTime ? (Date.now() - recordingStartTime) : 0;
          
          try {
            // Create a temporary file for download
            const tempFile = new File([audioBlob], "recording.temp", { type: mimeType });
            
            // Make sure we have a valid port connection
            if (!backgroundPort) {
              connectToBackground();
              
              // Since we can't use await directly in this context,
              // we'll continue with port if available, otherwise use messages
              if (!backgroundPort) {
                // Fallback to message API - but we'll handle that elsewhere
                throw new Error("Could not establish port connection");
              }
            }
            
            // Use the configured chunk size for reliable transfer
            const CHUNK_SIZE = CONFIG.AUDIO.CHUNK_SIZE;
            const reader = new FileReader();
            
            reader.onload = () => {
              const arrayBuffer = reader.result;
              const uint8Array = new Uint8Array(arrayBuffer);
              const totalChunks = Math.ceil(uint8Array.length / CHUNK_SIZE);
              
              // Reset our upload tracking
              uploadComplete = false;
              pendingChunks = 0;
              
              // First initialize the upload session
              backgroundPort.postMessage({
                type: 'init_upload',
                size: audioBlob.size,
                mimeType: mimeType,
                timestamp: timestamp,
                duration: duration,
                totalChunks: totalChunks
              });
              
              // Send chunks through the port connection
              for (let i = 0; i < totalChunks; i++) {
                const start = i * CHUNK_SIZE;
                const end = Math.min(start + CHUNK_SIZE, uint8Array.length);
                const chunk = uint8Array.slice(start, end);
                
                // Track this chunk as pending
                pendingChunks++;
                
                // Send the chunk through port
                backgroundPort.postMessage({
                  type: 'audio_chunk',
                  chunkIndex: i,
                  totalChunks: totalChunks,
                  // Use regular array for transfer since we're in the same extension context
                  chunk: Array.from(chunk), 
                  isLastChunk: i === totalChunks - 1
                });
              }
              
              // Mark the upload as complete on our side
              uploadComplete = true;
              
              // Wait for all chunks to be acknowledged by the background script
              if (pendingChunks === 0) {
                backgroundPort.postMessage({ 
                  type: 'transfer_complete',
                  timestamp: new Date().toISOString()
                });
              }
            };
            
            reader.onerror = (error) => {
              // Error handling
            };
            
            // Start reading the file
            reader.readAsArrayBuffer(tempFile);
          } catch (error) {
            // Error notification
            chrome.runtime.sendMessage({
              type: 'RECORDING_ERROR',
              error: `Failed to process recording: ${error.message}`
            });
          }
        } else {
          chrome.runtime.sendMessage({
            type: 'RECORDING_ERROR',
            error: 'Created an empty audio blob (0 bytes) - recording failed'
          });
        }
        
        audioChunks = [];
      } else {
        chrome.runtime.sendMessage({
          type: 'RECORDING_ERROR',
          error: 'No audio chunks collected during recording'
        });
      }
    };
    
    // Start recording with a small delay to ensure everything is set up
    await new Promise((resolve, reject) => {
      setTimeout(() => {
        try {
          // Only start if we're not already recording
          if (mediaRecorder && mediaRecorder.state !== 'recording') {
            // Request data every 3 seconds to prevent memory issues,
            // but we'll keep collecting chunks until stopped
            mediaRecorder.start(3000);
            
            // Record the start time
            recordingStartTime = Date.now();
            
            // Notify background script that recording has started
            chrome.runtime.sendMessage({ type: 'RECORDING_STARTED' });
            resolve();
          } else {
            resolve(); // Already recording, consider this a success
          }
        } catch (startError) {
          chrome.runtime.sendMessage({ 
            type: 'RECORDING_ERROR', 
            error: startError.message 
          });
          reject(new Error('Failed to start recording: ' + startError.message));
        }
      }, 100);
    });
    
    // Set up safety timeout to stop recording after configured max duration
    setTimeout(() => {
      if (isRecording()) {
        stopRecording().catch(error => {
          // Error handling
        });
      }
    }, CONFIG.AUDIO.MAX_RECORDING_DURATION);
    
    return { success: true };
  } catch (error) {
    await cleanupRecording();
    chrome.runtime.sendMessage({ 
      type: 'RECORDING_ERROR', 
      error: error.message 
    });
    throw error;
  }
}

// Clean up recording resources
async function cleanupRecording() {
  try {
    // Stop the media recorder
    if (mediaRecorder && mediaRecorder.state === 'recording') {
      mediaRecorder.stop();
    }
    
    // Close audio context
    if (audioContext) {
      try {
        await audioContext.close();
        audioContext = null;
      } catch (e) {
        // Just reset to null if we can't close it properly
        audioContext = null;
      }
    }
    
    // Stop all tracks in the stream
    if (stream) {
      try {
        const tracks = stream.getTracks();
        tracks.forEach(track => track.stop());
      } catch (e) {
        // Ignore errors
      }
      stream = null;
    }
    
    mediaRecorder = null;
    audioChunks = [];
    recordingStartTime = null;
  } catch (error) {
    // Just log the error and continue
    
    // Reset all state variables to ensure clean state
    mediaRecorder = null;
    audioChunks = [];
    stream = null;
    audioContext = null;
    recordingStartTime = null;
  }
}

// Upload in progress flag
let uploadInProgress = false;
let uploadPromise = null;

// Stop recording function
async function stopRecording(request) {
  try {
    // If we're not recording, just return
    if (!mediaRecorder || mediaRecorder.state !== 'recording') {
      return { success: true };
    }
    
    // Request the final data chunks and wait for them to be processed
    // This will trigger the ondataavailable and then onstop events
    mediaRecorder.stop();
    
    // Give time for the onstop handler to process the chunks
    await new Promise(resolve => setTimeout(resolve, 1000));
    
    // Check if we should wait for any upload to complete
    if (request && request.waitForUpload) {
      // If have an ongoing upload, wait for it
      if (uploadInProgress && uploadPromise) {
        try {
          await uploadPromise;
        } catch (e) {
          // Upload failed, but continuing with stop
        }
      }
    }
    
    // Clean up all recording resources
    await cleanupRecording();
    
    // Notify background script that recording has stopped
    chrome.runtime.sendMessage({ type: 'RECORDING_STOPPED' });
    
    return { success: true };
  } catch (error) {
    throw error;
  }
}

// Notify background script that offscreen document is ready
// Use both sendMessage and onMessage.addListener response patterns
// to ensure compatibility with different communication methods
function notifyBackgroundReady() {
  try {
    // Send a direct message that the document is ready
    chrome.runtime.sendMessage({ 
      type: 'OFFSCREEN_DOCUMENT_READY',
      timestamp: Date.now()
    }).catch(e => {});
    
    // Also set up a listener for pings
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.type === 'PING_OFFSCREEN') {
        sendResponse({ pong: true, timestamp: Date.now() });
        return true; // Keep sendResponse valid
      }
    });
    
    // Send another ready message after a delay to handle race conditions
    setTimeout(() => {
      chrome.runtime.sendMessage({ 
        type: 'OFFSCREEN_DOCUMENT_READY',
        timestamp: Date.now()
      }).catch(e => {});
    }, 1000);
  } catch (e) {
    // Error handling
  }
}

// Call the notification function when document is loaded
notifyBackgroundReady();
