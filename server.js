// server.js - OpenAI to NVIDIA NIM API Proxy
const express = require('express');
const cors = require('cors');
const axios = require('axios');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// NVIDIA NIM API configuration
const NIM_API_BASE = process.env.NIM_API_BASE || 'https://integrate.api.nvidia.com/v1';
const NIM_API_KEY = process.env.NIM_API_KEY;

// 🔥 REASONING DISPLAY TOGGLE - Shows/hides reasoning in output
const SHOW_REASONING = false; // Set to true to show reasoning with <think> tags

// 🔥 THINKING MODE TOGGLE - Enables thinking for specific models that support it
const ENABLE_THINKING_MODE = false; // Set to true to enable chat_template_kwargs thinking parameter

// Model mapping (adjust based on available NIM models)
const MODEL_MAPPING = {
  'gpt-3.5-turbo': 'meta/llama-3.1-8b-instruct',
  'gpt-4': 'meta/llama-3.1-70b-instruct',
  'gpt-4-turbo': 'meta/llama-3.3-70b-instruct',
  'gpt-4o': 'meta/llama-3.3-70b-instruct',
  'claude-3-opus': 'meta/llama-3.1-70b-instruct',
  'claude-3-sonnet': 'meta/llama-3.1-8b-instruct',
  'gemini-pro': 'nvidia/llama-3.1-nemotron-70b-instruct'
};


// Health check endpoint
// Root endpoint for connection tests
   app.get('/', (req, res) => {
     res.json({ 
       status: 'ok', 
       service: 'OpenAI to NVIDIA NIM Proxy',
       message: 'Proxy is running. Use /v1/chat/completions endpoint.'
     });
   });
app.get('/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    service: 'OpenAI to NVIDIA NIM Proxy', 
    reasoning_display: SHOW_REASONING,
    thinking_mode: ENABLE_THINKING_MODE
  });
});

// List models endpoint (OpenAI compatible)
app.get('/v1/models', (req, res) => {
  const models = Object.keys(MODEL_MAPPING).map(model => ({
    id: model,
    object: 'model',
    created: Date.now(),
    owned_by: 'nvidia-nim-proxy'
  }));
  
  res.json({
    object: 'list',
    data: models
  });
});

// Chat completions endpoint (main proxy)
// Chat completions endpoint (main proxy)
app.post('/v1/chat/completions', async (req, res) => {
  try {
    const { model, messages, temperature, max_tokens, stream } = req.body;
    
    console.log(`[REQUEST] Model: ${model}, Stream: ${stream}, MaxTokens: ${max_tokens}`);
    
    // Smart model selection with fallback
    let nimModel = MODEL_MAPPING[model];
    if (!nimModel) {
      console.log(`[MODEL] No mapping found for ${model}, using fallback`);
      const modelLower = model.toLowerCase();
      if (modelLower.includes('gpt-4') || modelLower.includes('claude-opus')) {
        nimModel = 'meta/llama-3.1-70b-instruct';
      } else {
        nimModel = 'meta/llama-3.1-8b-instruct';
      }
    }
    
    console.log(`[NVIDIA] Using model: ${nimModel}`);
    
    // Transform OpenAI request to NIM format
    const nimRequest = {
      model: nimModel,
      messages: messages,
      temperature: temperature || 0.7,
      top_p: 1,
      max_tokens: Math.min(max_tokens || 1024, 2048), // Cap at 2048
      stream: stream || false
    };
    
    console.log(`[API CALL] Starting request to NVIDIA...`);
    
    // Make request to NVIDIA NIM API with timeout handling
    const response = await axios.post(`${NIM_API_BASE}/chat/completions`, nimRequest, {
      headers: {
        'Authorization': `Bearer ${NIM_API_KEY}`,
        'Content-Type': 'application/json'
      },
      responseType: stream ? 'stream' : 'json',
      timeout: 90000, // 90 second timeout
      httpAgent: httpAgent,
      httpsAgent: httpsAgent,
      validateStatus: function (status) {
        return status < 600; // Accept any status less than 600
      }
    });
    
    console.log(`[NVIDIA RESPONSE] Status: ${response.status}`);
    
    // Check if NVIDIA returned an error
    if (response.status !== 200) {
      console.error(`[NVIDIA ERROR] ${response.status}: ${JSON.stringify(response.data)}`);
      return res.status(response.status).json({
        error: {
          message: response.data?.error?.message || 'NVIDIA API error',
          type: 'api_error',
          code: response.status
        }
      });
    }
    
    if (stream) {
      console.log(`[STREAM] Starting stream response`);
      // Handle streaming response
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let chunkCount = 0;
      
      response.data.on('data', (chunk) => {
        chunkCount++;
        const lines = chunk.toString().split('\n').filter(line => line.trim());
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            res.write(line + '\n\n');
          }
        });
      });
      
      response.data.on('end', () => {
        console.log(`[STREAM] Completed. Chunks sent: ${chunkCount}`);
        res.end();
      });
      
      response.data.on('error', (err) => {
        console.error('[STREAM ERROR]', err);
        if (!res.headersSent) {
          res.status(500).json({ error: { message: 'Stream error occurred' } });
        }
        res.end();
      });
    } else {
      console.log(`[NON-STREAM] Processing response`);
      
      // Validate response structure
      if (!response.data || !response.data.choices || !Array.isArray(response.data.choices)) {
        console.error(`[INVALID RESPONSE] Missing choices array:`, JSON.stringify(response.data));
        return res.status(500).json({
          error: {
            message: 'Invalid response from NVIDIA API',
            type: 'api_error',
            code: 500
          }
        });
      }
      
      // Transform NIM response to OpenAI format
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => ({
          index: choice.index || 0,
          message: {
            role: choice.message?.role || 'assistant',
            content: choice.message?.content || ''
          },
          finish_reason: choice.finish_reason || 'stop'
        })),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      console.log(`[SUCCESS] Response length: ${openaiResponse.choices[0].message.content.length} chars`);
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('[PROXY ERROR]', error.message);
    console.error('[ERROR DETAILS]', {
      code: error.code,
      status: error.response?.status,
      data: error.response?.data
    });
    
    // Handle timeout specifically
    if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
      return res.status(504).json({
        error: {
          message: 'Request timed out. Try a shorter prompt or smaller max_tokens.',
          type: 'timeout_error',
          code: 504
        }
      });
    }
    
    // Handle NVIDIA API errors
    if (error.response?.data) {
      return res.status(error.response.status || 500).json({
        error: {
          message: error.response.data.error?.message || error.message,
          type: 'api_error',
          code: error.response.status || 500
        }
      });
    }
    
    res.status(500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'proxy_error',
        code: 500
      }
    });
  }
});
```
    
    if (stream) {
      // Handle streaming response with reasoning
      res.setHeader('Content-Type', 'text/event-stream');
      res.setHeader('Cache-Control', 'no-cache');
      res.setHeader('Connection', 'keep-alive');
      
      let buffer = '';
      let reasoningStarted = false;
      
      response.data.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\\n');
        buffer = lines.pop() || '';
        
        lines.forEach(line => {
          if (line.startsWith('data: ')) {
            if (line.includes('[DONE]')) {
              res.write(line + '\\n');
              return;
            }
            
            try {
              const data = JSON.parse(line.slice(6));
              if (data.choices?.[0]?.delta) {
                const reasoning = data.choices[0].delta.reasoning_content;
                const content = data.choices[0].delta.content;
                
                if (SHOW_REASONING) {
                  let combinedContent = '';
                  
                  if (reasoning && !reasoningStarted) {
                    combinedContent = '<think>\\n' + reasoning;
                    reasoningStarted = true;
                  } else if (reasoning) {
                    combinedContent = reasoning;
                  }
                  
                  if (content && reasoningStarted) {
                    combinedContent += '</think>\\n\\n' + content;
                    reasoningStarted = false;
                  } else if (content) {
                    combinedContent += content;
                  }
                  
                  if (combinedContent) {
                    data.choices[0].delta.content = combinedContent;
                    delete data.choices[0].delta.reasoning_content;
                  }
                } else {
                  if (content) {
                    data.choices[0].delta.content = content;
                  } else {
                    data.choices[0].delta.content = '';
                  }
                  delete data.choices[0].delta.reasoning_content;
                }
              }
              res.write(`data: ${JSON.stringify(data)}\\n\\n`);
            } catch (e) {
              res.write(line + '\\n');
            }
          }
        });
      });
      
      response.data.on('end', () => res.end());
      response.data.on('error', (err) => {
        console.error('Stream error:', err);
        res.end();
      });
    } else {
      // Transform NIM response to OpenAI format with reasoning
      const openaiResponse = {
        id: `chatcmpl-${Date.now()}`,
        object: 'chat.completion',
        created: Math.floor(Date.now() / 1000),
        model: model,
        choices: response.data.choices.map(choice => {
          let fullContent = choice.message?.content || '';
          
          if (SHOW_REASONING && choice.message?.reasoning_content) {
            fullContent = '<think>\\n' + choice.message.reasoning_content + '\\n</think>\\n\\n' + fullContent;
          }
          
          return {
            index: choice.index,
            message: {
              role: choice.message.role,
              content: fullContent
            },
            finish_reason: choice.finish_reason
          };
        }),
        usage: response.data.usage || {
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0
        }
      };
      
      res.json(openaiResponse);
    }
    
  } catch (error) {
    console.error('Proxy error:', error.message);
    
    res.status(error.response?.status || 500).json({
      error: {
        message: error.message || 'Internal server error',
        type: 'invalid_request_error',
        code: error.response?.status || 500
      }
    });
  }
});

// Catch-all for unsupported endpoints
app.all('*', (req, res) => {
  res.status(404).json({
    error: {
      message: `Endpoint ${req.path} not found`,
      type: 'invalid_request_error',
      code: 404
    }
  });
});

app.listen(PORT, () => {
  console.log(`OpenAI to NVIDIA NIM Proxy running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/health`);
  console.log(`Reasoning display: ${SHOW_REASONING ? 'ENABLED' : 'DISABLED'}`);
  console.log(`Thinking mode: ${ENABLE_THINKING_MODE ? 'ENABLED' : 'DISABLED'}`);
});
