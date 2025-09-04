// Background script for Course Note Taker extension

// TEMPORARILY ENABLE console for debugging
// console.log = function() {};
// console.error = function() {};
// console.warn = function() {};
// console.info = function() {};
// console.debug = function() {};

console.log('[DEBUG] Background script loaded!');

// Port connection handling for reliable audio transfer
let audioPort = null;
let currentUploadSession = null;

// Handle port connections from offscreen document
chrome.runtime.onConnect.addListener((port) => {
  if (port.name === CONFIG.AUDIO.PORT_NAME) {
    audioPort = port;
    
    // Set up listener for messages from the offscreen document
    port.onMessage.addListener((message) => {
      // Handle log messages from offscreen
      if (message.type === 'LOG_MESSAGE') {
        return;
      }
      
      // Handle ready notification
      if (message.type === 'offscreen_ready') {
        return;
      }
      
      // Handle upload initialization
      if (message.type === 'init_upload') {
        handleInitUpload(message);
        return;
      }
      
      // Handle audio chunk
      if (message.type === 'audio_chunk') {
        handleAudioChunk(message);
        return;
      }
      
      // Handle transfer completion
      if (message.type === 'transfer_complete') {
        handleTransferComplete();
        return;
      }
    });
    
    // Handle disconnection
    port.onDisconnect.addListener(() => {
      audioPort = null;
      
      // If we have a pending upload session, handle it (but only if not already processing)
      if (currentUploadSession && 
          currentUploadSession.chunks.length > 0 && 
          currentUploadSession.receivedChunks === currentUploadSession.totalChunks &&
          !uploadInProgressId) {
        processPortUpload();
      }
    });
  }
});

// Handle initialization of a new upload session via port
function handleInitUpload(message) {
  // Create a new upload session
  currentUploadSession = {
    size: message.size,
    mimeType: message.mimeType,
    timestamp: message.timestamp,
    duration: message.duration,
    totalChunks: message.totalChunks,
    receivedChunks: 0,
    chunks: new Array(message.totalChunks),
    inProgress: true
  };
  
  // Acknowledge the initialization
  if (audioPort) {
    audioPort.postMessage({ 
      type: 'init_ack',
      timestamp: new Date().toISOString()
    });
  }
}

// Handle receiving an audio chunk via port
function handleAudioChunk(message) {
  // Make sure we have an active session
  if (!currentUploadSession) {
    return;
  }
  
  // Store the chunk
  currentUploadSession.chunks[message.chunkIndex] = new Uint8Array(message.chunk);
  currentUploadSession.receivedChunks++;
  
  // Acknowledge receipt
  if (audioPort) {
    audioPort.postMessage({ 
      type: 'chunk_ack',
      chunkIndex: message.chunkIndex
    });
  }
  
  // Check if we have all chunks
  if (currentUploadSession.receivedChunks === currentUploadSession.totalChunks) {
    // Wait for explicit completion signal or process immediately if offscreen is gone
    if (!audioPort) {
      processPortUpload();
    }
  }
}

// Keep track of upload processing to prevent duplicates
let uploadInProgressId = null;

// Handle transfer completion notification
function handleTransferComplete() {
  // Only process if not already in progress
  if (!uploadInProgressId) {
    processPortUpload();
  }
}

// Process the uploaded chunks from port connection
function processPortUpload() {
  // Make sure we have a valid upload session
  if (!currentUploadSession || currentUploadSession.receivedChunks !== currentUploadSession.totalChunks) {
    return;
  }
  
  // Generate a unique ID for this upload session
  uploadInProgressId = `upload-${Date.now()}`;
  
  // Upload directly to R2
  uploadFromPortSession()
    .catch(error => {
      // Reset the upload ID when complete (success or failure)
      uploadInProgressId = null;
    })
    .finally(() => {
      // Reset the upload ID when complete (success or failure)
      uploadInProgressId = null;
    });
}

// Prepare metadata for R2 upload from port session
async function prepareR2UploadMetadata() {
  try {
    // Convert timestamp to a format without colons for R2 key compatibility
    const formattedTimestamp = currentUploadSession.timestamp.replace(/:/g, '-');
    
    // Get file extension based on MIME type
    const fileExtension = currentUploadSession.mimeType === 'audio/wav' ? 'wav' : 'webm';
    
    // Get user information and stored session IDs
    const { userInfo, userToken, lastSessionId, currentSessionId } = 
      await chrome.storage.local.get(['userInfo', 'userToken', 'lastSessionId', 'currentSessionId']);
    
    if (!userToken) {
      throw new Error('No authentication token available');
    }
    
    // Check all possible session ID sources, prioritizing the stored values
    // This ensures we use the correct session ID even if the in-memory one is lost
    const effectiveSessionId = currentSessionId || sessionId || lastSessionId || 'unknown';
    
    // Generate a unique key for the audio file AFTER getting userInfo
    const key = `recordings/${userInfo?.id || 'anonymous'}-${effectiveSessionId}/complete-recording-${formattedTimestamp}.${fileExtension}`;
    
    // Prepare metadata
    const metadata = {
      'user-id': userInfo?.id || 'anonymous',
      'user-email': userInfo?.email || '',
      'session-id': effectiveSessionId,
      'timestamp': currentUploadSession.timestamp,
      'duration': String(currentUploadSession.duration),
      'content-disposition': 'attachment'
    };
    
    return { key, metadata };
  } catch (error) {
    throw error;
  }
}

// Upload the recording from port session directly to R2
async function uploadFromPortSession() {
  try {
    // Create a blob from all chunks
    const blob = new Blob(currentUploadSession.chunks, { type: currentUploadSession.mimeType });
    
    // Get metadata for R2 upload
    const { key, metadata } = await prepareR2UploadMetadata();
    
    // Upload with retry logic
    const MAX_RETRIES = CONFIG.UPLOAD.MAX_RETRIES;
    let retryCount = 0;
    let uploadSuccess = false;
    
    while (retryCount < MAX_RETRIES && !uploadSuccess) {
      try {
        // Upload directly to R2
        const uploadStartTime = Date.now();
        const uploadResult = await uploadToR2(key, blob, currentUploadSession.mimeType, metadata);
        
        // Upload succeeded
        const uploadDuration = (Date.now() - uploadStartTime) / 1000;
        uploadSuccess = true;
        
        // Show notification
        console.log('[DEBUG] Upload success - Port session path');
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'public/icons/record.png',
            title: 'Recording Upload Complete',
            message: `Successfully uploaded recording to Cloudflare (${Math.round(blob.size/1024/1024)}MB) - Port path`,
            priority: 2
          });
        } catch (e) {
          // Error creating notification
        }
        
        // Notify popup if open
        try {
          chrome.runtime.sendMessage({
            type: 'RECORDING_UPLOAD_COMPLETE',
            objectKey: key,
            size: blob.size,
            mimeType: currentUploadSession.mimeType
          });
        } catch (e) {
          // Popup might not be open
        }

        // Start transcription in background
        console.log('[DEBUG] Starting transcription for key:', key);
        // Debug notification
        try {
          chrome.notifications.create({
            type: 'basic',
            iconUrl: 'public/icons/record.png',
            title: 'DEBUG: Transcription Starting',
            message: `Starting transcription for: ${key.substring(0, 20)}...`,
            priority: 1
          });
        } catch (e) {}
        
        try {
          // Wait a moment for upload to fully complete, then transcribe from R2
          setTimeout(() => {
            transcribeFromR2(key)
            .then(transcriptionResult => {
              // Show transcription complete notification
              chrome.notifications.create({
                type: 'basic',
                iconUrl: 'public/icons/record.png',
                title: 'Transcription Complete',
                message: 'Audio has been transcribed successfully',
                priority: 2
              });

              // Notify popup if open
              try {
                chrome.runtime.sendMessage({
                  type: 'TRANSCRIPTION_COMPLETE',
                  objectKey: key,
                  transcription: transcriptionResult
                });
              } catch (e) {
                // Popup might not be open
              }
            })
            .catch(error => {
              // Show transcription error notification
              chrome.notifications.create({
                type: 'basic',
                iconUrl: 'public/icons/record.png',
                title: 'Transcription Failed',
                message: `Failed to transcribe audio: ${error.message}`,
                priority: 2
              });
            });
          }, 2000); // Wait 2 seconds for upload to complete
        } catch (e) {
          // Error starting transcription
          console.log('[DEBUG] Error starting transcription:', e);
        }
      } catch (error) {
        retryCount++;
        
        if (retryCount >= MAX_RETRIES) {
          // All retries failed
          
          // Notify popup if open
          try {
            chrome.runtime.sendMessage({
              type: 'RECORDING_WARNING',
              warning: `Upload failed after ${MAX_RETRIES} attempts: ${error.message}`
            });
          } catch (e) {
            // Popup might not be open
          }
        } else {
          // Wait before retrying (exponential backoff)
          const delay = Math.pow(2, retryCount) * CONFIG.UPLOAD.RETRY_DELAY_BASE;
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
    }
    
    // Clean up session
    currentUploadSession = null;
  } catch (error) {
    currentUploadSession = null;
    throw error;
  }
}

// Recording state
let isRecording = false;
let offscreenCreated = false;
let transcriptChunks = [];
let sessionId = null;
let currentTabInfo = null;
let isOffscreenInitialized = false;

// Configuration constants
const CONFIG = {
  // API endpoints - separate Cloudflare Workers for different functions
  APIS: {
    NOTION_API_URL: process.env.NOTION_API_URL,
    R2_API_URL: process.env.R2_API_URL,
    CLOUDFLARE_R2_ENDPOINT: process.env.CLOUDFLARE_R2_ENDPOINT 
  },
  // Audio processing settings
  AUDIO: {
    MAX_RECORDING_DURATION: 8 * 60 * 1000,  // 8 minutes in milliseconds
    CHUNK_SIZE: 150 * 1024,                 // 150KB chunks for port transfer
    PORT_NAME: 'audio_channel',             // Name for port connection
    MAX_LOG_SIZE: 1000000                   // ~1MB max size for debug logs
  },
  // Upload settings
  UPLOAD: {
    MAX_RETRIES: 3,                         // Number of upload retry attempts
    RETRY_DELAY_BASE: 2000,                 // Base retry delay in ms (doubles each retry)
    HEARTBEAT_INTERVAL: 2000,               // Upload heartbeat interval
    HEARTBEAT_TIMEOUT: 30000                // Time to consider upload stalled
  }
};

// Check if the offscreen document exists
async function hasOffscreenDocument() {
  try {
    const existingContexts = await chrome.runtime.getContexts({
      contextTypes: ['OFFSCREEN_DOCUMENT']
    });
    return existingContexts.length > 0;
  } catch (e) {
    return false;
  }
}

// Create or ensure the offscreen document exists and is ready
async function ensureOffscreenDocument() {
  try {
    // We'll try a total of 3 attempts to create a working offscreen document
    for (let attempt = 1; attempt <= 3; attempt++) {
      // Clean slate - close any existing document first
      try {
        await closeOffscreenDocument();
        await new Promise(resolve => setTimeout(resolve, 1000)); // Give Chrome time to clean up
      } catch (e) {
        // No document to close or error during cleanup
      }
      
      try {
        // Create a fresh offscreen document
        await chrome.offscreen.createDocument({
          url: 'offscreen.html',
          reasons: ['USER_MEDIA'],
          justification: 'Recording audio from tabs'
        });
        
        offscreenCreated = true;
        
        // Longer wait for document to initialize completely
        const loadDelay = 3000; // 3 seconds
        await new Promise(resolve => setTimeout(resolve, loadDelay));
        
        // Set up event listener for when document is ready
        const readyPromise = new Promise((resolve) => {
          const messageListener = (message) => {
            if (message.type === 'OFFSCREEN_DOCUMENT_READY') {
              chrome.runtime.onMessage.removeListener(messageListener);
              resolve(true);
            }
          };
          
          chrome.runtime.onMessage.addListener(messageListener);
          
          // Also set a timeout to remove the listener
          setTimeout(() => {
            chrome.runtime.onMessage.removeListener(messageListener);
            resolve(false);
          }, 5000);
        });
        
        // Send a ping to the offscreen document
        const pingPromise = new Promise((resolve) => {
          chrome.runtime.sendMessage({ 
            type: 'PING_OFFSCREEN',
            timestamp: Date.now()
          }, response => {
            if (response && response.pong) {
              resolve(true);
            } else {
              resolve(false);
            }
          });
          
          // Also set a timeout
          setTimeout(() => resolve(false), 3000);
        });
        
        // Wait for either the ready message or ping response
        const documentReady = await Promise.race([readyPromise, pingPromise]);
        
        if (documentReady) {
          isOffscreenInitialized = true;
          return true;
        }
      } catch (error) {
        // Handle the "Only a single offscreen document" error
        if (error.message.includes('Only a single offscreen document')) {
          // Force close any existing document and retry
          try {
            await chrome.offscreen.closeDocument();
            await new Promise(resolve => setTimeout(resolve, 2000));
          } catch (closeError) {
            await new Promise(resolve => setTimeout(resolve, 2000));
          }
        } else {
          if (attempt === 3) {
            throw error; // Rethrow on final attempt
          }
          // Wait longer between attempts
          await new Promise(resolve => setTimeout(resolve, 2000));
        }
      }
    }
    
    // If we get here, all attempts failed
    return false;
    
  } catch (error) {
    throw new Error('Could not create offscreen document: ' + error.message);
  }
}

// Legacy function for backward compatibility
async function setupOffscreenDocument() {
  return ensureOffscreenDocument();
}

// Close the offscreen document - with safer error handling
async function closeOffscreenDocument() {
  try {
    // First check if we have an offscreen document
    const documentExists = await hasOffscreenDocument();
    
    if (!documentExists) {
      // No document to close
      offscreenCreated = false;
      isOffscreenInitialized = false;
      return;
    }
    
    // If we have an existing document, try to stop any ongoing recording first
    try {
      // Send a stop message to ensure any recording is properly stopped
      await chrome.runtime.sendMessage({ type: 'STOP_RECORDING' }).catch(e => {
        // Ignore errors, just trying to clean up
      });
      
      // Small delay to allow offscreen to process the stop
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (e) {
      // Ignore any errors in this cleanup attempt
    }
    
    // Now try to close the document
    await chrome.offscreen.closeDocument();
    offscreenCreated = false;
    isOffscreenInitialized = false;
    
    // Additional delay to ensure proper cleanup of resources
    await new Promise(resolve => setTimeout(resolve, 500));
    
    // On some platforms, Chrome needs extra time to fully release audio resources
    // This delay helps prevent "Cannot capture a tab with an active stream" errors
    await new Promise(resolve => setTimeout(resolve, 500));
  } catch (error) {
    // Ignore errors, but reset our state
    offscreenCreated = false;
    isOffscreenInitialized = false;
    
    // Force a delay even on error to give Chrome time to clean up
    await new Promise(resolve => setTimeout(resolve, 1000));
  }
}

// Send a message to the offscreen document with validation
async function sendMessageToOffscreen(message) {
  // First verify the offscreen document exists and is initialized
  if (!offscreenCreated || !isOffscreenInitialized) {
    const success = await ensureOffscreenDocument();
    if (!success) {
      throw new Error("Offscreen document could not be initialized");
    }
  }
  
  return new Promise((resolve, reject) => {
    try {
      // Add a timestamp to help identify this specific request
      const requestWithTimestamp = {
        ...message,
        timestamp: Date.now()
      };
      
      // The proper way to communicate with offscreen documents
      chrome.runtime.sendMessage(requestWithTimestamp)
        .then(response => {
          resolve(response);
        })
        .catch(error => {
          reject(error);
        });
    } catch (error) {
      reject(error);
    }
  });
}

// Generate a unique session ID
function generateSessionId() {
  return Date.now().toString(36) + Math.random().toString(36).substring(2);
}

// Listen for installation
chrome.runtime.onInstalled.addListener(() => {
  // Initialize storage with default values
  chrome.storage.local.set({
    isLoggedIn: false,
    userToken: null,
    notionConnected: false,
    notionAccessToken: null,
    transcriptChunks: [],
    isRecording: false,
    summaryStatus: null,
    latestSummary: null
  });
});

// Helper function to get current active tab
async function getCurrentTab() {
  try {
    const queryOptions = { active: true, currentWindow: true };
    const tabs = await chrome.tabs.query(queryOptions);
    
    if (tabs.length === 0) {
      throw new Error('No active tab found');
    }
    
    return tabs[0];
  } catch (error) {
    throw new Error('Could not find active tab: ' + error.message);
  }
}

// Track current recording task to prevent duplicates
let currentRecordingTask = null;

// Message handling from popup and offscreen document
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  // Handle document ready notifications from offscreen
  if (request.type === 'OFFSCREEN_DOCUMENT_READY') {
    isOffscreenInitialized = true;
    offscreenCreated = true;
    sendResponse({ acknowledged: true });
    return false;
  }

  // Handle messages from popup
  if (request.type === 'START_RECORDING') {
    // Prevent duplicate START requests
    if (currentRecordingTask) {
      currentRecordingTask
        .then(() => sendResponse({ status: 'started', success: true }))
        .catch(error => {
          sendResponse({ status: 'error', success: false, error: error.message });
        });
      return true;
    }
    
    currentRecordingTask = handleStartRecording()
      .then(result => {
        currentRecordingTask = null;
        sendResponse({ status: 'started', success: true });
        return result;
      })
      .catch(error => {
        currentRecordingTask = null;
        sendResponse({ status: 'error', success: false, error: error.message });
        throw error; // Rethrow to propagate to other handlers
      });
    
    return true; // Keep sendResponse valid after the function returns
  }
  
  if (request.type === 'STOP_RECORDING') {
    // Cancel any pending start operation
    currentRecordingTask = null;
    
    handleStopRecording()
      .then(() => sendResponse({ status: 'stopped', success: true }))
      .catch(error => {
        sendResponse({ status: 'error', success: false, error: error.message });
      });
    return true; // Keep sendResponse valid after the function returns
  }
  
  if (request.type === 'GET_RECORDING_STATE') {
    // Get state from storage to ensure consistency
    chrome.storage.local.get(['isRecording'], (result) => {
      // Check both in-memory and storage state
      const currentState = isRecording || (result.isRecording === true);
      sendResponse({ isRecording: currentState, requestId: request.requestId });
    });
    return true; // Indicate we'll send response asynchronously
  }
  
  // New handler for getting current tab info (used by offscreen.js for YouTube detection)
  if (request.type === 'GET_CURRENT_TAB_INFO') {
    if (currentTabInfo) {
      sendResponse(currentTabInfo);
    } else {
      sendResponse({ error: 'No current tab info available' });
    }
    return false; // No async response needed
  }
  
  // Handle request to check if tab has audio playing
  if (request.type === 'CHECK_TAB_AUDIO') {
    // Get the current tab info
    if (!currentTabInfo || !currentTabInfo.id) {
      sendResponse({ hasAudio: false, error: 'No valid tab info available' });
      return false;
    }
    
    try {
      // Execute script in the tab to check for audio
      chrome.scripting.executeScript({
        target: { tabId: currentTabInfo.id },
        func: () => {
          // Look for video or audio elements that are playing
          const mediaElements = [...document.querySelectorAll('video, audio')];
          
          // Check if any media element is actually playing
          const playingMedia = mediaElements.filter(el => 
            !el.paused && !el.ended && el.currentTime > 0
          );
          
          return {
            hasAudio: playingMedia.length > 0,
            mediaCount: mediaElements.length,
            playingCount: playingMedia.length
          };
        }
      }).then(results => {
        if (results && results[0] && results[0].result) {
          sendResponse(results[0].result);
        } else {
          sendResponse({ hasAudio: false, error: 'Could not detect audio state' });
        }
      }).catch(err => {
        sendResponse({ hasAudio: false, error: err.message });
      });
      
      return true; // We'll respond asynchronously
    } catch (e) {
      sendResponse({ hasAudio: false, error: e.message });
      return false;
    }
  }
  
  // Handle recording lifecycle messages from offscreen document
  if (request.type === 'RECORDING_STARTING') {
    // Don't set recording state yet, just acknowledge the intent
    return false;
  }
  
  if (request.type === 'RECORDING_STARTED') {
    isRecording = true;
    chrome.storage.local.set({ isRecording: true });
    
    // Make sure popup UI is updated to show recording status
    try {
      // This will broadcast to all listeners including the popup
      chrome.runtime.sendMessage({ 
        type: 'RECORDING_STATE_CHANGED',
        isRecording: true
      }).catch(e => {});
    } catch (e) {
      // Ignore errors - popup might not be open
    }
    return false;
  }
  
  if (request.type === 'RECORDING_STOPPED') {
    isRecording = false;
    chrome.storage.local.set({ isRecording: false });
    // Make sure popup UI is updated
    try {
      // This will broadcast to all listeners including the popup
      chrome.runtime.sendMessage({ 
        type: 'RECORDING_STATE_CHANGED',
        isRecording: false
      }).catch(e => {});
    } catch (e) {
      // Ignore errors - popup might not be open
    }
    return false;
  }
  
  if (request.type === 'RECORDING_WARNING') {
    // Send warning to popup if it's open
    try {
      chrome.runtime.sendMessage({
        type: 'RECORDING_WARNING',
        warning: request.warning
      }).catch(e => {});
    } catch (e) {
      // Ignore errors - popup might not be open
    }
    
    return false;
  }
  
  if (request.type === 'RECORDING_ERROR') {
    // Immediately ensure we're not in recording state
    isRecording = false;
    chrome.storage.local.set({ isRecording: false });
    
    // Prevent "auto restart" by cleaning up the offscreen document right away
    try {
      closeOffscreenDocument().catch(e => {});
    } catch (e) {
      // Ignore errors
    }
    
    // Make sure popup UI is updated
    try {
      // This will broadcast to all listeners including the popup
      chrome.runtime.sendMessage({ 
        type: 'RECORDING_STATE_CHANGED',
        isRecording: false,
        error: request.error
      }).catch(e => {});
    } catch (e) {
      // Ignore errors - popup might not be open
    }
    
    return false;
  }
  
  // Handle chunked transfer of large recordings
  if (request.type === 'START_CHUNKED_TRANSFER') {
    // Initialize the collection for this transfer - use global variable in service worker context
    // (Don't use window object in a service worker)
    globalThis.audioChunksBuffer = {
      chunks: [],
      received: 0,
      total: request.totalChunks,
      totalBytes: request.totalBytes,
      mimeType: request.mimeType,
      timestamp: request.timestamp,
      duration: request.duration
    };
    return false;
  }
  
  if (request.type === 'AUDIO_DATA_CHUNK') {
    // Process incoming audio data chunk
    handleAudioDataChunk(
      request.chunk, 
      request.chunkIndex, 
      request.totalChunks, 
      request.isLastChunk,
      request.mimeType,
      request.timestamp
    );
    return false;
  }
  
  if (request.type === 'GET_DIRECT_UPLOAD_URL') {
    // Create a signed URL for direct upload from offscreen document
    handleDirectUploadRequest(request, sendResponse);
    return true; // Keep sendResponse valid
  }
  
  if (request.type === 'DIRECT_UPLOAD_COMPLETE') {
    // Reset upload in progress flag
    uploadInProgress = false;
    chrome.storage.local.set({ uploadInProgress: false });
    
    // Notify popup of successful upload
    try {
      chrome.runtime.sendMessage({
        type: 'RECORDING_UPLOAD_COMPLETE',
        objectKey: request.objectKey,
        size: request.size,
        mimeType: request.mimeType
      });
    } catch (e) {
      // Popup might not be open
    }
    
    return false;
  }
  
  // Handle persistent notifications
  if (request.type === 'PERSISTENT_NOTIFICATION') {
    try {
      // Create a Chrome notification
      chrome.notifications.create({
        type: 'basic',
        iconUrl: 'public/icons/record.png',
        title: 'Recording Upload Complete',
        message: request.message,
        priority: 2
      });
      
      // Store in local storage for persistence
      chrome.storage.local.set({
        lastUpload: {
          timestamp: new Date().toISOString(),
          objectKey: request.url,
          message: request.message
        }
      });
    } catch (e) {
      // Error creating notification
    }
    return false;
  }
  
  // Handle upload heartbeat to keep track of ongoing uploads
  if (request.type === 'UPLOAD_HEARTBEAT') {
    // Update the upload in progress flag to keep the document alive
    uploadInProgress = true;
    
    // Store heartbeat info
    chrome.storage.local.set({ 
      uploadInProgress: true,
      uploadHeartbeat: {
        timestamp: Date.now(),
        elapsed: request.elapsed,
        objectKey: request.objectKey,
        size: request.size
      }
    });
    
    return false;
  }
  
  // Handle large file upload preparation
  if (request.type === 'PREPARE_LARGE_UPLOAD') {
    // Set up storage for this upload
    chrome.storage.local.set({
      largeUpload: {
        inProgress: true,
        size: request.size,
        mimeType: request.mimeType,
        objectKey: request.objectKey,
        timestamp: request.timestamp,
        chunks: {},
        receivedChunks: 0,
        totalChunks: 0
      }
    });
    
    // Send notification to user
    try {
      chrome.runtime.sendMessage({
        type: 'RECORDING_WARNING',
        warning: `Large recording detected (${Math.round(request.size/1024/1024)}MB). Upload will continue in background.`
      });
    } catch (e) {
      // Popup might not be open
    }
    
    return false;
  }
  
  // Handle audio chunk storage
  if (request.type === 'STORE_AUDIO_CHUNK') {
    // Use a promise-based approach that's compatible with message handlers
    chrome.storage.local.get(['largeUpload']).then(result => {
      const { largeUpload } = result;
      
      if (!largeUpload) {
        return;
      }
      
      // Update with this chunk
      const chunks = largeUpload.chunks || {};
      chunks[request.chunkIndex] = request.chunk;
      
      // Update progress
      const updatedUpload = {
        ...largeUpload,
        chunks,
        receivedChunks: largeUpload.receivedChunks + 1,
        totalChunks: request.totalChunks
      };
      
      // Save updated state
      return chrome.storage.local.set({ largeUpload: updatedUpload });
    }).catch(e => {
      // Error handling
    });
    
    return false;
  }
  
  // Handle initiating background upload
  if (request.type === 'INITIATE_BACKGROUND_UPLOAD') {
    // Start a background task to handle the upload
    setTimeout(() => {
      uploadLargeFileFromStorage(request.objectKey, request.mimeType);
    }, 1000);
    
    return false;
  }
  
  // Handle upload status updates
  if (request.type === 'UPLOAD_STATUS') {
    // Forward to popup if open
    try {
      chrome.runtime.sendMessage({
        type: 'RECORDING_UPLOAD_STATUS',
        status: request.status,
        progress: request.progress,
        message: request.message
      });
    } catch (e) {
      // Popup might not be open
    }
    
    return false;
  }
  
  if (request.type === 'RECORDING_TOO_LARGE') {
    return false;
  }
  
  // Keep the offscreen document alive
  if (request.type === 'OFFSCREEN_DOCUMENT_READY') {
    sendResponse({ acknowledged: true });
    return false;
  }
  
  // Handle log messages from offscreen document
  if (request.type === 'LOG_MESSAGE') {
    return false;
  }
  
  // Handle special requests to verify tab state
  if (request.type === 'VERIFY_TAB_STATE') {
    getCurrentTab()
      .then(tab => {
        sendResponse({ 
          success: true, 
          tabId: tab.id,
          tabTitle: tab.title,
          tabUrl: tab.url
        });
      })
      .catch(error => {
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep sendResponse valid
  }
  
  // Handle manual summary check request from popup
  if (request.type === 'CHECK_SUMMARY') {
    console.log("[DEBUG BACKGROUND] Received CHECK_SUMMARY request:", request);
    
    // If forceFresh is set, clear any existing summary data
    if (request.forceFresh) {
      console.log("[DEBUG BACKGROUND] Force fresh check requested, clearing any cached data");
      chrome.storage.local.remove(['summaryStatus', 'latestSummary']);
    }
    
    // If a session ID was provided in the request, use it
    if (request.sessionId) {
      console.log("[DEBUG BACKGROUND] Using provided session ID:", request.sessionId);
      chrome.storage.local.set({
        lastSessionId: request.sessionId,
        currentSessionId: request.sessionId
      });
      
      // Create a new summaryStatus if we're forcing fresh
      if (request.forceFresh || !request.skipSetup) {
        console.log("[DEBUG BACKGROUND] Setting up new summary status with session ID:", request.sessionId);
        chrome.storage.local.set({
          summaryStatus: {
            sessionId: request.sessionId,
            status: 'awaiting_check',
            startTime: Date.now(),
            checkCount: 0,
            lastCheck: Date.now(),
            found: false,
            error: null
          }
        });
      }
    }
    
    // Force a check now
    checkForSummary()
      .then((result) => {
        console.log("[DEBUG BACKGROUND] checkForSummary completed with result:", result);
        
        // After checking, get the current summary status to include in response
        chrome.storage.local.get(['summaryStatus', 'latestSummary'], (data) => {
          console.log("[DEBUG BACKGROUND] Current summary status:", data.summaryStatus);
          console.log("[DEBUG BACKGROUND] Has summary:", !!data.latestSummary);
          
          sendResponse({ 
            success: true, 
            summaryFound: data.summaryStatus?.found || false,
            summaryStatus: data.summaryStatus
          });
        });
      })
      .catch(error => {
        console.error("[DEBUG BACKGROUND] Error in checkForSummary:", error);
        sendResponse({ success: false, error: error.message });
      });
    
    return true; // Keep sendResponse valid
  }
  
  // Track OneNote export to prevent duplicates
  let oneNoteExportInProgress = false;
  let processedRequestIds = new Set(); // Track which requests have been processed
  
  // Add handler to check if OneNote export is in progress
  if (request.type === 'CHECK_ONENOTE_EXPORT_STATUS') {
    // Return the current export status
    sendResponse({ exportInProgress: oneNoteExportInProgress });
    return true;
  }
  
  // Handle export to OneNote (to avoid CORS issues)
  if (request.type === 'EXPORT_TO_ONENOTE') {
    console.log("[DEBUG BACKGROUND] Received EXPORT_TO_ONENOTE request");
    
    // Check if we've already processed this specific request
    if (request.requestId && processedRequestIds.has(request.requestId)) {
      console.log("[DEBUG BACKGROUND] Already processed this exact request ID, ignoring duplicate");
      sendResponse({ success: false, error: "Request already processed" });
      return true;
    }
    
    // Check if an export is already in progress
    if (oneNoteExportInProgress) {
      console.log("[DEBUG BACKGROUND] OneNote export already in progress, ignoring duplicate request");
      sendResponse({ success: false, error: "Export already in progress" });
      return true;
    }
    
    // Record this request ID if it exists
    if (request.requestId) {
      processedRequestIds.add(request.requestId);
      
      // Clean up old request IDs (keep only the last 20)
      if (processedRequestIds.size > 20) {
        const oldestRequests = Array.from(processedRequestIds).slice(0, processedRequestIds.size - 20);
        oldestRequests.forEach(id => processedRequestIds.delete(id));
      }
    }
    
    // Set flag to prevent duplicate exports
    oneNoteExportInProgress = true;
    
    if (!request.accessToken) {
      oneNoteExportInProgress = false;
      sendResponse({ success: false, error: "No access token provided" });
      return true;
    }
    
    if (!request.content) {
      oneNoteExportInProgress = false;
      sendResponse({ success: false, error: "No content provided" });
      return true;
    }
    
    try {
      // First, get the available notebooks
      console.log("[DEBUG BACKGROUND] Getting OneNote notebooks");
      
      fetch('https://graph.microsoft.com/v1.0/me/onenote/notebooks', {
        method: 'GET',
        headers: {
          'Authorization': `Bearer ${request.accessToken}`,
          'Content-Type': 'application/json'
        }
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`OneNote API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then(data => {
        console.log("[DEBUG BACKGROUND] OneNote notebooks:", data);
        
        if (!data.value || data.value.length === 0) {
          throw new Error("No notebooks found in OneNote account");
        }
        
        // Use the first notebook or try to find one named "Gist" or "Notes"
        const notebook = data.value.find(nb => 
          nb.displayName === "Gist" || nb.displayName === "Notes"
        ) || data.value[0];
        
        console.log("[DEBUG BACKGROUND] Using notebook:", notebook.displayName);
        
        // Get sections in the notebook
        return fetch(`https://graph.microsoft.com/v1.0/me/onenote/notebooks/${notebook.id}/sections`, {
          method: 'GET',
          headers: {
            'Authorization': `Bearer ${request.accessToken}`,
            'Content-Type': 'application/json'
          }
        });
      })
      .then(response => {
        if (!response.ok) {
          throw new Error(`OneNote API error: ${response.status} ${response.statusText}`);
        }
        return response.json();
      })
      .then(data => {
        console.log("[DEBUG BACKGROUND] OneNote sections:", data);
        
        let section;
        
        if (!data.value || data.value.length === 0) {
          // No sections found, create a new one
          console.log("[DEBUG BACKGROUND] No sections found, will create a page in default section");
          return fetch('https://graph.microsoft.com/v1.0/me/onenote/pages', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${request.accessToken}`,
              'Content-Type': 'application/xhtml+xml'
            },
            body: request.content
          });
        } else {
          // Use first section or try to find one named "Gist" or "Meeting Notes"
          section = data.value.find(s => 
            s.displayName === "Gist" || s.displayName === "Meeting Notes"
          ) || data.value[0];
          
          console.log("[DEBUG BACKGROUND] Using section:", section.displayName);
          
          // Create a new page in the selected section
          return fetch(`https://graph.microsoft.com/v1.0/me/onenote/sections/${section.id}/pages`, {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${request.accessToken}`,
              'Content-Type': 'application/xhtml+xml'
            },
            body: request.content
          });
        }
      })
      .then(response => {
        if (!response.ok) {
          console.error("[DEBUG BACKGROUND] OneNote API error response:", response);
          return response.text().then(text => {
            console.error("[DEBUG BACKGROUND] Error details:", text);
            throw new Error(`OneNote API error: ${response.status} ${response.statusText}`);
          });
        }
        return response.json();
      })
      .then(data => {
        console.log("[DEBUG BACKGROUND] OneNote page created:", data);
        
        // Reset the export in progress flag
        oneNoteExportInProgress = false;
        
        // Return success with the page URL for opening
        sendResponse({
          success: true,
          pageUrl: data.links?.oneNoteWebUrl?.href || data.links?.oneNoteClientUrl?.href
        });
      })
      .catch(error => {
        console.error("[DEBUG BACKGROUND] OneNote export error:", error);
        
        // Reset the export in progress flag
        oneNoteExportInProgress = false;
        
        sendResponse({ 
          success: false, 
          error: error.message || "Error exporting to OneNote" 
        });
      });
      
      return true; // Will respond asynchronously
    } catch (error) {
      console.error("[DEBUG BACKGROUND] Error in EXPORT_TO_ONENOTE handler:", error);
      
      // Reset the export in progress flag
      oneNoteExportInProgress = false;
      
      sendResponse({ 
        success: false, 
        error: error.message || "Error exporting to OneNote" 
      });
      return true;
    }
  }
  
  // Handle LIST_SUMMARIES request from popup (to avoid CORS issues)
  if (request.type === 'LIST_SUMMARIES') {
    console.log("[DEBUG BACKGROUND] Received LIST_SUMMARIES request:", request);
    
    // Get the R2 worker URL from CONFIG
    const workerUrl = `${CONFIG.APIS.CLOUDFLARE_R2_ENDPOINT.replace('/r2-upload', '')}/r2-list`;
    const prefix = request.prefix;
    const userToken = request.userToken;
    
    if (!prefix || !userToken) {
      sendResponse({ 
        success: false, 
        error: !prefix ? "Missing prefix" : "Missing authentication token" 
      });
      return true;
    }
    
    // Use R2 list endpoint to get all files in the directory
    console.log("[DEBUG BACKGROUND] Listing R2 files with prefix:", prefix);
    
    fetch(workerUrl, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${userToken}`
      },
      body: JSON.stringify({
        prefix: prefix
      })
    })
    .then(response => response.json())
    .then(data => {
      console.log("[DEBUG BACKGROUND] R2 listing response:", data);
      
      if (data.success && data.summary) {
        // R2 worker already found and returned the latest summary
        console.log("[DEBUG BACKGROUND] Found summary:", data.summaryPath);
        
        // Store the summary data
        chrome.storage.local.set({
          summaryStatus: {
            sessionId: request.sessionId,
            status: 'ready',
            found: true,
            foundAt: Date.now(),
            foundPath: data.summaryPath
          },
          latestSummary: data.summary
        });
        
        // Send direct response
        sendResponse({
          success: true,
          summary: data.summary,
          summaryPath: data.summaryPath
        });
        
        // Also broadcast the SUMMARY_READY message for any listeners
        try {
          chrome.runtime.sendMessage({
            type: 'SUMMARY_READY',
            summaryData: data.summary
          });
        } catch (e) {
          console.log("[DEBUG BACKGROUND] Could not broadcast SUMMARY_READY (no listeners)");
        }
      } else {
        // No summary found
        console.log("[DEBUG BACKGROUND] No summaries found for prefix:", prefix);
        sendResponse({
          success: false,
          error: data.error || 'No summaries found'
        });
      }
    })
    .catch(error => {
      console.error("[DEBUG BACKGROUND] Error in LIST_SUMMARIES handler:", error);
      sendResponse({
        success: false,
        error: `Failed to fetch: ${error.message}`
      });
    });
    
  }
  
  // Handle immediate check for summary (triggered by popup)
  if (request.type === 'CHECK_SUMMARY_NOW') {
    // First check if we already have a summary in storage
    chrome.storage.local.get(['summaryStatus', 'latestSummary'], async (data) => {
      if (data.summaryStatus?.found && data.latestSummary) {
        // We already have a summary, return it immediately
        sendResponse({ 
          summaryFound: true, 
          summary: data.latestSummary 
        });
        
        // Also send a message that can be caught by listeners
        try {
          chrome.runtime.sendMessage({
            type: 'SUMMARY_READY',
            summaryData: data.latestSummary
          });
        } catch (e) {
          // Ignore errors from this broadcast
        }
      } else {
        // No summary found in storage, set up proper session ID
        // and start/continue the polling process
        
        // Update the session ID if one was provided
        if (request.sessionId) {
          // Store this session ID for summary checking
          chrome.storage.local.set({ 
            lastSessionId: request.sessionId,
            currentSessionId: request.sessionId
          });
          
          // Set up the summary status if not already done
          if (!data.summaryStatus || data.summaryStatus.status === 'error' || data.summaryStatus.status === 'timeout') {
            // Start a new polling session
            startSummaryPolling(request.sessionId);
          }
        }
        
        // Do an immediate check for the summary
        try {
          await checkForSummary();
          
          // Check if the summary was found in this immediate check
          const { summaryStatus, latestSummary } = await chrome.storage.local.get(['summaryStatus', 'latestSummary']);
          
          if (summaryStatus?.found && latestSummary) {
            sendResponse({ 
              summaryFound: true, 
              summary: latestSummary 
            });
          } else {
            // Start the alarm if not already running
            chrome.alarms.get('checkSummary', (alarm) => {
              if (!alarm) {
                // Set up periodic checking (every 10 seconds)
                chrome.alarms.create('checkSummary', {
                  periodInMinutes: 10/60 // 10 seconds
                });
              }
            });
            
            // No summary found yet, return false
            sendResponse({ summaryFound: false });
          }
        } catch (error) {
          console.error('Error checking for summary:', error);
          sendResponse({ 
            summaryFound: false, 
            error: error.message 
          });
        }
      }
    });
    
    return true; // Indicates we'll call sendResponse asynchronously
  }
  
  // Handle GET_CURRENT_TAB request from popup
  if (request.type === 'GET_CURRENT_TAB') {
    chrome.tabs.query({ active: true, currentWindow: true }, function(tabs) {
      if (tabs.length > 0) {
        const activeTab = tabs[0];
        console.log('[DEBUG] Current active tab:', activeTab.title);
        sendResponse({
          title: activeTab.title,
          url: activeTab.url,
          id: activeTab.id
        });
      } else {
        console.log('[DEBUG] No active tab found');
        sendResponse(null);
      }
    });
    return true; // Required for async response
  }
});

// Recording lock to prevent multiple simultaneous attempts
let recordingLock = false;

// Start recording handler with optimized document management
async function handleStartRecording() {
  // Prevent multiple simultaneous recording attempts
  if (recordingLock) {
    throw new Error("Recording start already in progress, please wait");
  }
  
  // Store current state in storage for reference
  await chrome.storage.local.set({ recordingLock: true });
  
  // Set the lock
  recordingLock = true;
  
  try {
    // If already recording, stop first
    if (isRecording) {
      await handleStopRecording();
      // Longer delay to ensure complete cleanup of stream
      await new Promise(resolve => setTimeout(resolve, 2000));
    }
    
    // Close any existing offscreen document to ensure clean start
    await closeOffscreenDocument();
    
    // Wait for resources to be fully released
    await new Promise(resolve => setTimeout(resolve, 2000));
    
    // Generate a new session ID for this recording
    sessionId = generateSessionId();
    
    // Store the session ID immediately in storage to prevent loss
    await chrome.storage.local.set({ 
      currentSessionId: sessionId, 
      lastSessionId: sessionId 
    });
    
    // Get the current tab info for metadata
    const tab = await getCurrentTab();
    if (!tab || !tab.id) {
      throw new Error('No valid tab found for recording');
    }
    
    // Store the current tab info for later use in chunk uploads
    currentTabInfo = {
      id: tab.id,
      title: tab.title,
      url: tab.url
    };
    
    // Create a fresh offscreen document using our improved function
    const documentReady = await ensureOffscreenDocument();
    
    if (!documentReady) {
      throw new Error("Failed to create or initialize offscreen document");
    }
    
    // Get the media stream ID here in the background script
    try {
      const streamId = await new Promise((resolve, reject) => {
        // Create a timeout to handle potential hanging getMediaStreamId
        const timeoutId = setTimeout(() => {
          reject(new Error('Timeout getting media stream ID - tab may have permission issues'));
        }, 5000);
        
        chrome.tabCapture.getMediaStreamId(
          { targetTabId: tab.id },
          streamId => {
            clearTimeout(timeoutId);
            if (chrome.runtime.lastError) {
              reject(new Error(chrome.runtime.lastError.message));
            } else {
              resolve(streamId);
            }
          }
        );
      });
      
      if (!streamId) {
        throw new Error('Failed to get media stream ID');
      }
      
      // Double-check the offscreen document is still active before sending message
      if (!offscreenCreated || !isOffscreenInitialized) {
        throw new Error("Offscreen document was closed or never properly initialized");
      }
      
      // Tell the offscreen document to start recording with the stream ID
      const response = await sendMessageToOffscreen({
        type: 'START_RECORDING',
        streamId: streamId,
        requestId: Date.now() // Add unique identifier
      });
      
      if (response && response.success) {
        isRecording = true;
        // Update storage with recording state
        await chrome.storage.local.set({ 
          isRecording: true,
          recordingStartTime: Date.now(),
          recordingTabId: tab.id
        });
        return { success: true };
      } else if (response && response.error) {
        throw new Error('Offscreen error: ' + response.error);
      } else {
        throw new Error('Unknown error starting recording');
      }
    } catch (error) {
      // If there's an error with the tab capture, provide a clearer message
      if (error.message.includes('Cannot capture') || error.message.includes('being captured')) {
        // Force close offscreen to release the stream
        await closeOffscreenDocument();
        
        // For YouTube specifically, provide focused guidance
        if (currentTabInfo && currentTabInfo.url && currentTabInfo.url.includes('youtube.com')) {
          throw new Error('YouTube tab capture conflict: Try refreshing the YouTube tab, then wait 10 seconds before recording. Some YouTube videos block recording.');
        } else {
          throw new Error('Tab capture conflict: Please refresh the tab, then wait 10 seconds before recording. If using multiple extensions, disable others that capture tab audio.');
        }
      } else if (error.message.includes('tabCapture') || error.message.includes('Tab')) {
        throw new Error('Please refresh the tab you want to record. Tab must be active and not be using its own media devices.');
      } else if (error.message.includes('timeout') || error.message.includes('timed out')) {
        // Force close offscreen document to clean up
        await closeOffscreenDocument();
        throw new Error('Operation timed out. Please refresh the tab and try again, or try another tab.');
      } else if (error.message.includes('Offscreen document not available') || 
                error.message.includes('Offscreen document was closed') ||
                error.message.includes('never properly initialized')) {
        // Special handling for offscreen document issues
        await closeOffscreenDocument();
        throw new Error('Extension document error: Please refresh the tab and try again. If this persists, try restarting your browser.');
      }
      throw error;
    }
  } catch (error) {
    isRecording = false;
    await chrome.storage.local.set({ isRecording: false });
    
    // Clean up on error
    try {
      await closeOffscreenDocument();
    } catch (e) {
      // Ignore cleanup errors
    }
    
    throw error;
  } finally {
    // Always release the recording lock, even on error
    recordingLock = false;
    await chrome.storage.local.set({ recordingLock: false });
  }
}

// Stop recording handler with improved state management
async function handleStopRecording() {
  try {
    // Save the stop request in storage to prevent races
    await chrome.storage.local.set({ isStoppingRecording: true });
    
    // Check if we even have an offscreen document
    const documentExists = await hasOffscreenDocument();
    
    if (!documentExists) {
      isRecording = false;
      await chrome.storage.local.set({ 
        isRecording: false,
        isStoppingRecording: false,
        recordingTabId: null,
        recordingStartTime: null
      });
      return { success: true };
    }
    
    // Try to communicate with the offscreen document to stop recording
    if (isOffscreenInitialized) {
      try {
        // Tell offscreen to stop recording with unique request ID
        const stopRequestId = Date.now();
        const response = await sendMessageToOffscreen({
          type: 'STOP_RECORDING',
          requestId: stopRequestId,
          // Don't wait for upload since we're using the background upload approach
          waitForUpload: false
        });
      } catch (e) {
        // Continue with cleanup anyway
      }
    }
    
    // Reset recording state
    isRecording = false;
    await chrome.storage.local.set({ 
      isRecording: false,
      isStoppingRecording: false,
      recordingTabId: null,
      recordingStartTime: null
    });
    
    // Save the current session ID for any pending uploads
    const currentSessionId = sessionId;
    const currentTab = currentTabInfo;
    
    // Store session ID and recording details in storage for tracking and retrieval
    await chrome.storage.local.set({ 
      lastSessionId: currentSessionId,
      lastTabInfo: currentTab, // This stores the tab title and URL for later use
      lastRecording: {
        userId: (await chrome.storage.local.get(['userInfo'])).userInfo?.id || 'anonymous',
        sessionId: currentSessionId,
        timestamp: Date.now(),
        tabInfo: currentTab, // Also store tab info in lastRecording object
        tabTitle: currentTab ? currentTab.title : null, // Explicitly store the title
        // Use a prefix pattern to match any summary-*.json files
        expectedSummaryPrefix: `summaries/${(await chrome.storage.local.get(['userInfo'])).userInfo?.id || 'anonymous'}-${currentSessionId}/`,
        expectedSummaryPath: `summaries/${(await chrome.storage.local.get(['userInfo'])).userInfo?.id || 'anonymous'}-${currentSessionId}/summary.json`
      }
    });
    
    // Start polling for summary after successful recording
    startSummaryPolling(currentSessionId);
    
    // Reset session ID and tab info in memory, but keep in storage
    sessionId = null;
    currentTabInfo = null;
    
    // IMPORTANT: For large uploads, we need to add a delay before closing the offscreen document
    // to give it time to send the data to the background script
    await new Promise(resolve => setTimeout(resolve, 5000));
    
    // Check if a large upload has been initiated by the offscreen document
    const { largeUpload } = await chrome.storage.local.get(['largeUpload']);
    
    if (largeUpload && largeUpload.inProgress) {
      // Add extra delay for large files to ensure more chunks get transferred
      if (largeUpload.size > 5 * 1024 * 1024) { // > 5MB
        const extraDelay = Math.min(largeUpload.size / (250 * 1024) * 100, 15000); // Max 15 seconds
        await new Promise(resolve => setTimeout(resolve, extraDelay));
      }
      
      // We can now close the offscreen document - background will handle remaining upload
      try {
        await closeOffscreenDocument();
      } catch (e) {
        // Error handling
      }
      
      // Start background upload after document is closed
      setTimeout(() => {
        if (largeUpload  && largeUpload.objectKey) {
          uploadLargeFileFromStorage(largeUpload.objectKey, largeUpload.mimeType);
        }
      }, 2000);
      
      return { success: true };
    }
    
    // For regular direct uploads (should be very rare now)
    const { uploadInProgress: uploadActive, uploadHeartbeat } = 
      await chrome.storage.local.get(['uploadInProgress', 'uploadHeartbeat']);
    
    if (uploadActive || uploadInProgress) {
      // Check if we have a recent heartbeat
      const currentTime = Date.now();
      const lastHeartbeat = uploadHeartbeat ? uploadHeartbeat.timestamp : 0;
      const heartbeatAge = (currentTime - lastHeartbeat) / 1000;
      
      // If there's been no heartbeat for 10 seconds, consider the upload stalled
      if (heartbeatAge > 10) {
        uploadInProgress = false;
        await chrome.storage.local.set({ uploadInProgress: false });
        
        try {
          await closeOffscreenDocument();
        } catch (e) {
          // Error handling
        }
        return { success: true };
      }
      
      // Otherwise wait a bit longer for direct uploads
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      try {
        await closeOffscreenDocument();
      } catch (e) {
        // Error handling
      }
      
      return { success: true };
    }
    
    // No upload in progress, just close the document
    try {
      await closeOffscreenDocument();
    } catch (e) {
      // Error handling
    }
    
    return { success: true };
  } catch (error) {
    // Set recording state to false anyway
    isRecording = false;
    
    // Make sure we update storage state on error too
    await chrome.storage.local.set({ 
      isRecording: false,
      isStoppingRecording: false,
      recordingTabId: null,
      recordingStartTime: null
    });
    
    // Force close offscreen even on error, but only if no upload is in progress
    try {
      if (!uploadInProgress) {
        await closeOffscreenDocument();
      }
    } catch (e) {
      // Ignore any errors during cleanup
    }
    
    throw error;
  }
}

// Upload directly to Cloudflare R2 storage
async function uploadToR2(key, audioBlob, contentType, metadata) {
  try {
    // Get the user token from storage
    const { userToken, userInfo } = await chrome.storage.local.get(['userToken', 'userInfo']);
    
    if (!userToken) {
      throw new Error('No authentication token found - please sign in');
    }
    
    // Validate that we have a proper Blob object
    if (!(audioBlob instanceof Blob)) {
      throw new Error('Invalid audio data: not a Blob object');
    }
    
    if (audioBlob.size === 0) {
      throw new Error('Cannot upload empty audio file');
    }
    
    // Metadata will be handled by the worker if needed
    
    // Make direct upload request to Cloudflare R2 worker
    const uploadUrl = `${CONFIG.APIS.CLOUDFLARE_R2_ENDPOINT}?key=${encodeURIComponent(key)}`;
    const response = await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': contentType
      },
      body: audioBlob
    });
    
    // Check for HTTP errors
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Failed to upload to R2: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    // Parse the response
    const result = await response.text();
    return { 
      success: true, 
      objectKey: key,
      message: result 
    };
  } catch (error) {
    // Try to give more specific error messages
    if (error.message.includes('Failed to fetch') || error.message.includes('NetworkError')) {
      throw new Error('Network error connecting to R2 service - check your internet connection');
    }
    throw error;
  }
}

// Transcribe uploaded audio using Cloudflare AI
async function transcribeAudio(audioKey, audioBlob) {
  try {
    // Get the user token from storage
    const { userToken } = await chrome.storage.local.get(['userToken']);
    
    if (!userToken) {
      throw new Error('No authentication token found');
    }
    
    // Create FormData for audio transcription
    const formData = new FormData();
    formData.append('audio', audioBlob);
    formData.append('key', audioKey);
    
    // Call transcription endpoint
    const transcribeUrl = `${CONFIG.APIS.CLOUDFLARE_R2_ENDPOINT.replace('/r2-upload', '')}/api/transcribe`;
    console.log('[DEBUG] Calling transcription API:', transcribeUrl);
    
    // Add timeout to prevent hanging
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
      console.log('[DEBUG] Transcription request timed out after 30 seconds');
      controller.abort();
    }, 30000); // 30 second timeout
    
    const response = await fetch(transcribeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`
      },
      body: formData,
      signal: controller.signal
    });
    
    clearTimeout(timeoutId);
    console.log('[DEBUG] Transcription response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Transcription failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    return result;
  } catch (error) {
    throw error;
  }
}

// Transcribe audio from R2 storage (fetch the uploaded file and transcribe it)
async function transcribeFromR2(audioKey) {
  try {
    // Get the user token from storage
    const { userToken } = await chrome.storage.local.get(['userToken']);
    
    if (!userToken) {
      throw new Error('No authentication token found');
    }

    console.log('[DEBUG] Fetching audio from R2 for transcription:', audioKey);

    // First, get the audio file from R2
    const getUrl = `${CONFIG.APIS.CLOUDFLARE_R2_ENDPOINT.replace('/r2-upload', '')}/r2-get`;
    const getResponse = await fetch(getUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ key: audioKey })
    });

    if (!getResponse.ok) {
      throw new Error(`Failed to fetch audio from R2: ${getResponse.status}`);
    }

    // Get the audio blob from R2
    const audioBlob = await getResponse.blob();
    console.log('[DEBUG] Fetched audio blob from R2, size:', audioBlob.size);

    // Now transcribe using the fetched audio
    const formData = new FormData();
    formData.append('audio', audioBlob);
    formData.append('key', audioKey);
    
    // Call transcription endpoint
    const transcribeUrl = `${CONFIG.APIS.CLOUDFLARE_R2_ENDPOINT.replace('/r2-upload', '')}/api/transcribe`;
    console.log('[DEBUG] Calling transcription API:', transcribeUrl);
    
    const response = await fetch(transcribeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`
      },
      body: formData
    });
    
    console.log('[DEBUG] Transcription response status:', response.status);
    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Transcription failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    console.log('[DEBUG] About to parse transcription JSON response...');
    const result = await response.json();
    console.log('[DEBUG] JSON parsed successfully');
    console.log('[DEBUG] Full transcription result:', result);
    console.log('[DEBUG] Transcription successful:', result.text?.substring(0, 50) + '...');
    console.log('[DEBUG] Transcription result structure:', { success: result.success, hasText: !!result.text });
    
    // Auto-generate summary after successful transcription
    if (result.success) {
      console.log('[DEBUG] Scheduling summary generation in 1 second...');
      setTimeout(() => {
        console.log('[DEBUG] Starting summary generation now...');
        summarizeTranscription(audioKey)
          .then(summaryResult => {
            console.log('[DEBUG] Summary generated successfully:', summaryResult.summary?.substring(0, 100) + '...');
          })
          .catch(error => {
            console.log('[DEBUG] Summary generation failed:', error.message || error);
            console.log('[DEBUG] Summary error details:', error);
          });
      }, 1000); // 1 second delay
    } else {
      console.log('[DEBUG] Transcription was not successful, skipping summary generation');
    }
    
    return result;
  } catch (error) {
    console.log('[DEBUG] Transcription error:', error);
    throw error;
  }
}

// Generate AI summary from transcription
async function summarizeTranscription(audioKey) {
  try {
    // Get the user token from storage
    const { userToken } = await chrome.storage.local.get(['userToken']);
    
    if (!userToken) {
      throw new Error('No authentication token found');
    }

    console.log('[DEBUG] Generating summary for audio key:', audioKey);

    // Call summarization endpoint
    const summarizeUrl = `${CONFIG.APIS.CLOUDFLARE_R2_ENDPOINT.replace('/r2-upload', '')}/api/summarize`;
    console.log('[DEBUG] Calling summarization API:', summarizeUrl);
    
    const response = await fetch(summarizeUrl, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${userToken}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ audioKey: audioKey })
    });
    
    console.log('[DEBUG] Summarization response status:', response.status);

    if (!response.ok) {
      const errorText = await response.text();
      throw new Error(`Summarization failed: ${response.status} ${response.statusText} - ${errorText}`);
    }
    
    const result = await response.json();
    console.log('[DEBUG] Summarization successful:', result.summary?.substring(0, 100) + '...');
    return result;
  } catch (error) {
    console.log('[DEBUG] Summarization error:', error);
    throw error;
  }
}


    }
    
  
}
