// Cloudflare Worker for Notion OAuth with Secret Store Integration
// Showcase: Secret Store, OAuth Flow, Chrome Extension CORS

// CORS headers for preflight requests
const corsHeaders = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Content-Type': 'application/json'
}

export default {
  async fetch(request, env) {
    try {
      return await handleRequest(request, env);
    } catch (error) {
      // Global error handler for uncaught exceptions
      console.error('Unhandled error:', error);
      return new Response(JSON.stringify({
        error: 'Internal server error',
        message: error.message
      }), {
        status: 500,
        headers: {
          'Content-Type': 'application/json',
          'Access-Control-Allow-Origin': '*'
        }
      });
    }
  }
};

async function handleRequest(request, env) {
  try {
    const url = new URL(request.url);
    console.log('handleRequest called - method:', request.method, 'pathname:', url.pathname);

    // Handle GET request for config - demonstrates Secret Store retrieval
    if (request.method === 'GET' && url.pathname === '/config') {
      try {
        console.log('Config endpoint hit - checking secret store binding');
        
        // Check if YOUR_CLIENT_ID binding exists
        if (!env.YOUR_CLIENT_ID) {
          console.error('YOUR_CLIENT_ID binding not found in env');
          return new Response(JSON.stringify({
            error: 'Secret Store binding YOUR_CLIENT_ID not configured',
            debug: 'Check wrangler.toml for secret store bindings'
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        console.log('YOUR_CLIENT_ID binding found, attempting to get value');
        
        // Get YOUR_CLIENT_ID from secret store
        const clientId = await env.YOUR_CLIENT_ID.get();
        
        console.log('Secret store get() completed, value exists:', !!clientId);
        
        if (!clientId) {
          return new Response(JSON.stringify({
            error: 'YOUR_CLIENT_ID not found in secret store',
            debug: 'Secret exists in binding but value is null/empty'
          }), {
            status: 500,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*'
            }
          });
        }

        console.log('Successfully retrieved client ID from secret store');

        return new Response(JSON.stringify({
          clientId: clientId
        }), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        console.error('Config endpoint error:', error);
        return new Response(JSON.stringify({
          error: 'Error accessing Notion configuration',
          message: error.message,
          stack: error.stack,
          debug: 'Check secret store configuration and bindings'
        }), {
          status: 500,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      }
    }

    // Handle CORS preflight requests
    if (request.method === 'OPTIONS') {
      return handleCORS();
    }

    // For the Notion token exchange endpoint (root path) - demonstrates dual Secret Store usage
    console.log('Checking POST root path - method matches:', request.method === 'POST', 'pathname matches:', url.pathname === '/', 'actual pathname:', url.pathname);
    if (request.method === 'POST' && url.pathname === '/') {
      try {
        console.log('POST / endpoint hit - starting token exchange process');
        
        // Parse request body
        let reqBody;
        try {
          reqBody = await request.json();
          console.log('Request body parsed successfully');
        } catch (error) {
          console.error('Failed to parse request body:', error);
          return new Response(JSON.stringify({
            error: 'Invalid JSON in request body',
            message: error.message
          }), {
            status: 400,
            headers: corsHeaders
          });
        }

        const { code, redirectUri } = reqBody;
        console.log('Extracted parameters - code exists:', !!code, 'redirectUri exists:', !!redirectUri);

        // Required parameters for token exchange
        if (!code) {
          console.log('Missing authorization code');
          return new Response(JSON.stringify({ error: 'Missing authorization code' }), {
            status: 400,
            headers: corsHeaders
          });
        }

        if (!redirectUri) {
          console.log('Missing redirect URI');
          return new Response(JSON.stringify({ error: 'Missing redirect URI' }), {
            status: 400,
            headers: corsHeaders
          });
        }

        console.log('Parameters validated, checking credentials');

        // Check if YOUR_CLIENT_ID secret store binding exists
        if (!env.YOUR_CLIENT_ID) {
          console.error('YOUR_CLIENT_ID secret store binding not found');
          return new Response(JSON.stringify({
            error: 'YOUR_CLIENT_ID secret store binding not configured'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        console.log('YOUR_CLIENT_ID binding exists, getting value from secret store');

        // Get both YOUR_CLIENT_ID and YOUR_CLIENT_SECRET from secret store
        const clientId = await env.YOUR_CLIENT_ID.get();
        
        console.log('Secret store get() completed - client ID exists:', !!clientId);
        
        // Check if YOUR_CLIENT_SECRET secret store binding exists
        if (!env.YOUR_CLIENT_SECRET) {
          console.error('YOUR_CLIENT_SECRET secret store binding not found');
          return new Response(JSON.stringify({
            error: 'YOUR_CLIENT_SECRET secret store binding not configured'
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        console.log('YOUR_CLIENT_SECRET binding exists, getting value from secret store');
        const clientSecret = await env.YOUR_CLIENT_SECRET.get();
        
        console.log('Both secrets retrieved - clientId exists:', !!clientId, 'clientSecret exists:', !!clientSecret);

        if (!clientId || !clientSecret) {
          console.error('Credentials check failed - clientId:', !!clientId, 'clientSecret:', !!clientSecret);
          return new Response(JSON.stringify({
            error: 'Notion credentials not configured on server',
            debug: {
              clientIdFromSecretStore: !!clientId,
              clientSecretFromSecretStore: !!clientSecret
            }
          }), {
            status: 500,
            headers: corsHeaders
          });
        }

        console.log('All credentials validated, proceeding with Notion API call');

        // Exchange code for token with Notion API
        console.log('Making request to Notion API...');
        let tokenResponse;
        try {
          tokenResponse = await fetch('https://api.notion.com/v1/oauth/token', {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'Authorization': 'Basic ' + btoa(clientId + ':' + clientSecret)
            },
            body: JSON.stringify({
              grant_type: 'authorization_code',
              code: code,
              redirect_uri: redirectUri
            })
          });
          console.log('Notion API response status:', tokenResponse.status);
        } catch (error) {
          console.error('Failed to connect to Notion API:', error);
          return new Response(JSON.stringify({
            error: 'Failed to connect to Notion API',
            message: error.message
          }), {
            status: 502,
            headers: corsHeaders
          });
        }

        if (!tokenResponse.ok) {
          let errorText;
          try {
            const errorData = await tokenResponse.json();
            errorText = JSON.stringify(errorData);
          } catch (e) {
            errorText = await tokenResponse.text();
          }

          return new Response(JSON.stringify({
            error: `Notion API returned ${tokenResponse.status}`,
            details: errorText
          }), {
            status: tokenResponse.status,
            headers: corsHeaders
          });
        }

        let tokenData;
        try {
          tokenData = await tokenResponse.json();
        } catch (error) {
          return new Response(JSON.stringify({
            error: 'Invalid JSON in Notion response',
            message: error.message
          }), {
            status: 502,
            headers: corsHeaders
          });
        }

        // Return the token response to the extension
        return new Response(JSON.stringify(tokenData), {
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*'
          }
        });
      } catch (error) {
        console.error('Unexpected error in POST / endpoint:', error);
        return new Response(JSON.stringify({
          error: 'Internal server error processing Notion request',
          message: error.message,
          stack: error.stack,
          name: error.name
        }), {
          status: 500,
          headers: corsHeaders
        });
      }
    }

    // Default response for unsupported methods or paths
    return new Response(JSON.stringify({
      error: 'Not found',
      path: url.pathname,
      method: request.method
    }), {
      status: 404,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  } catch (error) {
    // Catch-all error handler for the main function
    return new Response(JSON.stringify({
      error: 'Global request handling error',
      message: error.message
    }), {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*'
      }
    });
  }
}

function handleCORS() {
  return new Response(null, {
    headers: corsHeaders
  })
}
