// Cloudflare Worker for handling direct R2 uploads and AI processing
// Showcase: R2 Storage, AI Gateway, Whisper Transcription, BART Summarization

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 200,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Max-Age': '86400',
        },
      });
    }

    // Handle R2 upload endpoint
    if (path === '/r2-upload' && request.method === 'PUT') {
      return await handleR2Upload(request, env);
    }

    // Handle audio transcription endpoint
    if (path === '/api/transcribe' && request.method === 'POST') {
      console.log('Transcription endpoint hit:', request.method, path);
      return await handleTranscribe(request, env);
    }

    // Handle R2 list endpoint (for summaries)
    if (path === '/r2-list' && request.method === 'POST') {
      return await handleR2List(request, env);
    }

    // Handle R2 get endpoint (for retrieving files)
    if (path === '/r2-get' && request.method === 'POST') {
      return await handleR2Get(request, env);
    }

    // Handle transcription retrieval
    if (path === '/api/transcription' && request.method === 'GET') {
      return await handleGetTranscription(request, env);
    }

    // Handle AI summarization
    if (path === '/api/summarize' && request.method === 'POST') {
      return await handleSummarize(request, env);
    }

    return new Response('Not Found', { status: 404 });
  },
};

// Handle direct R2 upload
async function handleR2Upload(request, env) {
  try {
    // Extract auth token
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const token = authHeader.substring(7);
    
    // For now, we'll skip token validation
    // In production, you'd validate the Google token here
    
    // Get the key from the URL or body
    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    
    if (!key) {
      return new Response('Missing key parameter', { status: 400 });
    }

    // Get the request body (audio blob)
    const audioBlob = await request.blob();
    
    if (audioBlob.size === 0) {
      return new Response('Empty file', { status: 400 });
    }

    // Upload to R2
    await env.GIST_RECORDINGS.put(key, audioBlob, {
      httpMetadata: {
        contentType: request.headers.get('Content-Type') || 'audio/webm',
      },
    });

    return new Response(JSON.stringify({
      success: true,
      message: `Successfully uploaded ${key}`,
      key: key,
      size: audioBlob.size
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('R2 upload error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Handle R2 list operation (for finding summaries)
async function handleR2List(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { prefix } = await request.json();
    
    if (!prefix) {
      return new Response('Missing prefix', { status: 400 });
    }

    // List objects with the given prefix
    const listed = await env.GIST_RECORDINGS.list({ prefix });
    
    // Look for summary files
    const summaryFiles = listed.objects.filter(obj => 
      obj.key.includes('summary') && obj.key.endsWith('.json')
    );

    if (summaryFiles.length === 0) {
      return new Response(JSON.stringify({
        success: false,
        error: 'No summaries found'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    // Get the most recent summary
    const latestSummary = summaryFiles.sort((a, b) => 
      new Date(b.uploaded) - new Date(a.uploaded)
    )[0];

    // Retrieve the summary content
    const summaryObj = await env.GIST_RECORDINGS.get(latestSummary.key);
    const summaryData = await summaryObj.json();

    return new Response(JSON.stringify({
      success: true,
      summary: summaryData,
      summaryPath: latestSummary.key
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('R2 list error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Handle R2 get operation (for retrieving specific files)
async function handleR2Get(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const { key } = await request.json();
    
    if (!key) {
      return new Response('Missing key', { status: 400 });
    }

    // Get the object from R2
    const obj = await env.GIST_RECORDINGS.get(key);
    
    if (!obj) {
      return new Response('File not found', { status: 404 });
    }

    return new Response(obj.body, {
      status: 200,
      headers: {
        'Content-Type': obj.httpMetadata?.contentType || 'application/octet-stream',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('R2 get error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Utility function: Convert ArrayBuffer -> Base64 safely
function arrayBufferToBase64(arrayBuffer) {
  let binary = '';
  const bytes = new Uint8Array(arrayBuffer);
  const chunkSize = 0x8000; // 32KB per slice is safe

  for (let i = 0; i < bytes.length; i += chunkSize) {
    const slice = bytes.subarray(i, i + chunkSize);
    binary += String.fromCharCode.apply(null, slice);
  }
  
  return btoa(binary);
}

// Handle audio transcription using Cloudflare AI
async function handleTranscribe(request, env) {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  
  // Log request start with structured data
  console.log({
    event: 'transcription_request_started',
    request_id: requestId,
    timestamp: new Date().toISOString(),
    endpoint: '/api/transcribe',
    method: request.method
  });

  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log({
        event: 'authentication_failed',
        request_id: requestId,
        reason: 'missing_or_invalid_bearer_token',
        timestamp: new Date().toISOString()
      });
      return new Response('Unauthorized', { status: 401 });
    }

    // Get form data with audio file
    const formData = await request.formData();
    const audioFile = formData.get('audio');
    const audioKey = formData.get('key'); // Optional: R2 key for storing transcription
    
    if (!audioFile) {
      console.log({
        event: 'transcription_validation_failed',
        request_id: requestId,
        reason: 'no_audio_file_provided',
        timestamp: new Date().toISOString()
      });
      return new Response('No audio file provided', { status: 400 });
    }

    // Get audio buffer and process as single file
    const audioBuffer = await audioFile.arrayBuffer();
    const audioSizeMB = (audioBuffer.byteLength / (1024 * 1024)).toFixed(2);
    
    // Log audio file details
    console.log({
      event: 'audio_file_processed',
      request_id: requestId,
      audio_key: audioKey,
      file_size_bytes: audioBuffer.byteLength,
      file_size_mb: parseFloat(audioSizeMB),
      file_type: audioFile.type || 'unknown',
      timestamp: new Date().toISOString()
    });
    
    // Check if file is too large for processing (25MB limit)
    if (audioBuffer.byteLength > 25 * 1024 * 1024) {
      console.log({
        event: 'transcription_validation_failed',
        request_id: requestId,
        reason: 'file_too_large',
        file_size_mb: parseFloat(audioSizeMB),
        max_size_mb: 25,
        timestamp: new Date().toISOString()
      });
      throw new Error('Audio file too large for transcription (max 25MB)');
    }
    
    // Convert entire audio buffer to base64
    const conversionStart = Date.now();
    const base64Audio = arrayBufferToBase64(audioBuffer);
    const conversionTime = Date.now() - conversionStart;
    
    console.log({
      event: 'audio_conversion_completed',
      request_id: requestId,
      conversion_time_ms: conversionTime,
      base64_size_chars: base64Audio.length,
      timestamp: new Date().toISOString()
    });
    
    // Log AI model invocation
    const aiStart = Date.now();
    console.log({
      event: 'ai_transcription_started',
      request_id: requestId,
      model: '@cf/openai/whisper-large-v3-turbo',
      gateway_id: 'your-ai-gateway',
      cache_enabled: true,
      timestamp: new Date().toISOString()
    });
    
    // Transcribe using Whisper-large-v3-turbo through AI Gateway
    const response = await env.AI.run('@cf/openai/whisper-large-v3-turbo', {
      audio: base64Audio
    }, {
      gateway: {
        id: "your-ai-gateway",
        skipCache: false
      }
    });
    
    const aiTime = Date.now() - aiStart;
    const transcriptionText = response.text || '';
    const wordCount = transcriptionText.trim().split(/\s+/).length;
    
    console.log({
      event: 'ai_transcription_completed',
      request_id: requestId,
      model: '@cf/openai/whisper-large-v3-turbo',
      processing_time_ms: aiTime,
      transcription_length_chars: transcriptionText.length,
      transcription_word_count: wordCount,
      confidence_score: response.confidence || null,
      timestamp: new Date().toISOString()
    });

    // If audioKey provided, store transcription in R2
    if (audioKey) {
      const r2Start = Date.now();
      const transcriptionKey = audioKey.replace(/\.(wav|mp3|webm)$/, '-transcription.json');
      const transcriptionData = {
        text: transcriptionText,
        timestamp: new Date().toISOString(),
        audioKey: audioKey,
        model: '@cf/openai/whisper-large-v3-turbo',
        processing_time_ms: aiTime,
        word_count: wordCount
      };

      await env.GIST_RECORDINGS.put(transcriptionKey, JSON.stringify(transcriptionData), {
        httpMetadata: {
          contentType: 'application/json',
        },
      });
      
      const r2Time = Date.now() - r2Start;
      console.log({
        event: 'transcription_stored_r2',
        request_id: requestId,
        transcription_key: transcriptionKey,
        storage_time_ms: r2Time,
        data_size_bytes: JSON.stringify(transcriptionData).length,
        timestamp: new Date().toISOString()
      });
    }

    const totalTime = Date.now() - startTime;
    console.log({
      event: 'transcription_request_completed',
      request_id: requestId,
      total_processing_time_ms: totalTime,
      success: true,
      audio_size_mb: parseFloat(audioSizeMB),
      transcription_word_count: wordCount,
      performance_metrics: {
        conversion_time_ms: conversionTime,
        ai_processing_time_ms: aiTime,
        total_time_ms: totalTime
      },
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      text: transcriptionText,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      processing_time_ms: totalTime
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.log({
      event: 'transcription_request_failed',
      request_id: requestId,
      error_type: error.name,
      error_message: error.message,
      processing_time_ms: errorTime,
      stack_trace: error.stack,
      model_used: '@cf/openai/whisper-large-v3-turbo',
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      request_id: requestId,
      details: {
        stack: error.stack,
        name: error.name,
        modelUsed: '@cf/openai/whisper-large-v3-turbo'
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Handle transcription retrieval
async function handleGetTranscription(request, env) {
  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return new Response('Unauthorized', { status: 401 });
    }

    const url = new URL(request.url);
    const key = url.searchParams.get('key');
    
    if (!key) {
      return new Response('Missing key parameter', { status: 400 });
    }

    // Generate transcription key from audio key
    const transcriptionKey = key.replace(/\.(wav|mp3|webm)$/, '-transcription.json');
    
    // Get transcription from R2
    const transcriptionObj = await env.GIST_RECORDINGS.get(transcriptionKey);
    
    if (!transcriptionObj) {
      return new Response(JSON.stringify({
        success: false,
        error: 'Transcription not found'
      }), {
        status: 404,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const transcriptionData = await transcriptionObj.json();

    return new Response(JSON.stringify({
      success: true,
      transcription: transcriptionData
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    console.error('Get transcription error:', error);
    return new Response(JSON.stringify({
      success: false,
      error: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}

// Handle AI summarization of transcription
async function handleSummarize(request, env) {
  const startTime = Date.now();
  const requestId = crypto.randomUUID();
  
  // Log request start with structured data
  console.log({
    event: 'summarization_request_started',
    request_id: requestId,
    timestamp: new Date().toISOString(),
    endpoint: '/api/summarize',
    method: request.method
  });

  try {
    const authHeader = request.headers.get('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      console.log({
        event: 'authentication_failed',
        request_id: requestId,
        reason: 'missing_or_invalid_bearer_token',
        endpoint: '/api/summarize',
        timestamp: new Date().toISOString()
      });
      return new Response('Unauthorized', { status: 401 });
    }

    const { transcriptionKey, audioKey } = await request.json();
    
    console.log({
      event: 'summarization_input_received',
      request_id: requestId,
      transcription_key: transcriptionKey,
      audio_key: audioKey,
      input_source: transcriptionKey ? 'transcription_key' : 'audio_key',
      timestamp: new Date().toISOString()
    });
    
    if (!transcriptionKey && !audioKey) {
      console.log({
        event: 'summarization_validation_failed',
        request_id: requestId,
        reason: 'missing_transcription_key_and_audio_key',
        timestamp: new Date().toISOString()
      });
      return new Response('Missing transcriptionKey or audioKey parameter', { status: 400 });
    }

    let transcriptionData;
    let finalTranscriptionKey = transcriptionKey;

    // If audioKey provided, derive transcription key
    if (audioKey && !transcriptionKey) {
      finalTranscriptionKey = audioKey.replace(/\.(wav|mp3|webm)$/, '-transcription.json');
      console.log({
        event: 'transcription_key_derived',
        request_id: requestId,
        derived_key: finalTranscriptionKey,
        source_audio_key: audioKey,
        timestamp: new Date().toISOString()
      });
    }

    // Get transcription from R2
    const r2FetchStart = Date.now();
    const transcriptionObj = await env.GIST_RECORDINGS.get(finalTranscriptionKey);
    const r2FetchTime = Date.now() - r2FetchStart;
    
    if (!transcriptionObj) {
      console.log({
        event: 'transcription_not_found',
        request_id: requestId,
        transcription_key: finalTranscriptionKey,
        r2_fetch_time_ms: r2FetchTime,
        timestamp: new Date().toISOString()
      });
      return new Response(JSON.stringify({
        success: false,
        error: 'Transcription not found'
      }), { status: 404 });
    }

    transcriptionData = await transcriptionObj.json();
    const transcriptionText = transcriptionData.text || '';
    const transcriptionWordCount = transcriptionText.trim().split(/\s+/).length;

    console.log({
      event: 'transcription_retrieved',
      request_id: requestId,
      transcription_key: finalTranscriptionKey,
      r2_fetch_time_ms: r2FetchTime,
      transcription_length_chars: transcriptionText.length,
      transcription_word_count: transcriptionWordCount,
      original_model: transcriptionData.model || 'unknown',
      timestamp: new Date().toISOString()
    });

    if (!transcriptionText.trim()) {
      console.log({
        event: 'summarization_validation_failed',
        request_id: requestId,
        reason: 'empty_transcription_text',
        transcription_key: finalTranscriptionKey,
        timestamp: new Date().toISOString()
      });
      return new Response(JSON.stringify({
        success: false,
        error: 'No transcription text to summarize'
      }), { status: 400 });
    }

    // Log AI model invocation
    const aiStart = Date.now();
    console.log({
      event: 'ai_summarization_started',
      request_id: requestId,
      model: '@cf/facebook/bart-large-cnn',
      gateway_id: 'your-ai-gateway',
      input_text_length: transcriptionText.length,
      input_word_count: transcriptionWordCount,
      max_summary_length: 1024,
      cache_enabled: true,
      timestamp: new Date().toISOString()
    });

    // Generate summary using BART model through AI Gateway
    const summaryResponse = await env.AI.run('@cf/facebook/bart-large-cnn', {
      input_text: transcriptionText,
      max_length: 1024
    }, {
      gateway: {
        id: "your-ai-gateway",
        skipCache: false
      }
    });

    const aiTime = Date.now() - aiStart;
    const summaryText = summaryResponse.summary || '';
    const summaryWordCount = summaryText.trim().split(/\s+/).length;
    const compressionRatio = ((transcriptionText.length - summaryText.length) / transcriptionText.length * 100).toFixed(2);

    console.log({
      event: 'ai_summarization_completed',
      request_id: requestId,
      model: '@cf/facebook/bart-large-cnn',
      processing_time_ms: aiTime,
      input_length_chars: transcriptionText.length,
      input_word_count: transcriptionWordCount,
      summary_length_chars: summaryText.length,
      summary_word_count: summaryWordCount,
      compression_ratio_percent: parseFloat(compressionRatio),
      timestamp: new Date().toISOString()
    });

    // Store summary in R2
    const r2StoreStart = Date.now();
    const summaryKey = finalTranscriptionKey.replace('-transcription.json', '-summary.json');
    const summaryData = {
      summary: summaryText,
      transcriptionKey: finalTranscriptionKey,
      audioKey: audioKey || transcriptionData.audioKey,
      timestamp: new Date().toISOString(),
      model: '@cf/facebook/bart-large-cnn',
      processing_time_ms: aiTime,
      word_count: summaryWordCount,
      compression_ratio_percent: parseFloat(compressionRatio),
      original_transcription_word_count: transcriptionWordCount
    };

    await env.GIST_RECORDINGS.put(summaryKey, JSON.stringify(summaryData), {
      httpMetadata: {
        contentType: 'application/json',
      },
    });

    const r2StoreTime = Date.now() - r2StoreStart;
    console.log({
      event: 'summary_stored_r2',
      request_id: requestId,
      summary_key: summaryKey,
      storage_time_ms: r2StoreTime,
      data_size_bytes: JSON.stringify(summaryData).length,
      timestamp: new Date().toISOString()
    });

    const totalTime = Date.now() - startTime;
    console.log({
      event: 'summarization_request_completed',
      request_id: requestId,
      total_processing_time_ms: totalTime,
      success: true,
      input_word_count: transcriptionWordCount,
      summary_word_count: summaryWordCount,
      compression_ratio_percent: parseFloat(compressionRatio),
      performance_metrics: {
        r2_fetch_time_ms: r2FetchTime,
        ai_processing_time_ms: aiTime,
        r2_store_time_ms: r2StoreTime,
        total_time_ms: totalTime
      },
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: true,
      summary: summaryText,
      summaryKey: summaryKey,
      transcriptionKey: finalTranscriptionKey,
      timestamp: new Date().toISOString(),
      request_id: requestId,
      processing_time_ms: totalTime,
      compression_ratio_percent: parseFloat(compressionRatio)
    }), {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });

  } catch (error) {
    const errorTime = Date.now() - startTime;
    console.log({
      event: 'summarization_request_failed',
      request_id: requestId,
      error_type: error.name,
      error_message: error.message,
      processing_time_ms: errorTime,
      stack_trace: error.stack,
      model_used: '@cf/facebook/bart-large-cnn',
      timestamp: new Date().toISOString()
    });

    return new Response(JSON.stringify({
      success: false,
      error: error.message,
      request_id: requestId,
      details: {
        stack: error.stack,
        name: error.name,
        modelUsed: '@cf/facebook/bart-large-cnn'
      }
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
}
