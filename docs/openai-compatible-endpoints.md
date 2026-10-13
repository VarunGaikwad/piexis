# OpenAI-Compatible Endpoints

Pi can use self-hosted and third-party services that implement the OpenAI Chat Completions API, including Ollama, LM Studio, vLLM, SGLang, llama.cpp servers, and compatible proxies.

## Configure a provider

Create or update `~/.pi/agent/models.json`. Merge this provider into the existing `providers` object if the file already exists:

```json
{
  "providers": {
    "local-openai": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "$LOCAL_OPENAI_API_KEY",
      "models": [
        {
          "id": "your-model-id",
          "name": "My OpenAI-compatible model"
        }
      ]
    }
  }
}
```

Set the key before launching Pi:

```bash
export LOCAL_OPENAI_API_KEY="your-api-key"
pi
```

For a server that does not validate authentication, use a non-secret placeholder instead:

```json
"apiKey": "local"
```

Then open `/model` in Pi and select the configured provider and model.

## Values to replace

- `local-openai` is a local Pi provider ID; choose any unique name.
- `baseUrl` is the API base URL. Most OpenAI-compatible servers expect a URL ending in `/v1`.
- `your-model-id` must exactly match the model ID accepted by the endpoint.
- `LOCAL_OPENAI_API_KEY` is any environment-variable name used to hold the service's API key.

Pi sends requests to the Chat Completions API under the configured base URL. Do not put `/chat/completions` in `baseUrl`.

## Examples

### Ollama

Ollama's OpenAI-compatible API commonly runs at `http://localhost:11434/v1`:

```json
{
  "providers": {
    "ollama": {
      "baseUrl": "http://localhost:11434/v1",
      "api": "openai-completions",
      "apiKey": "ollama",
      "models": [
        { "id": "qwen2.5-coder:7b", "name": "Qwen 2.5 Coder 7B" }
      ]
    }
  }
}
```

### vLLM, SGLang, or LM Studio

These servers commonly expose an OpenAI-compatible API at port `8000` or a configured local port:

```json
{
  "providers": {
    "self-hosted": {
      "baseUrl": "http://localhost:8000/v1",
      "api": "openai-completions",
      "apiKey": "local",
      "models": [
        { "id": "model-name" }
      ]
    }
  }
}
```

## Optional model metadata

Add metadata when the endpoint's capabilities are known. For example, advertise vision input and a context window:

```json
{
  "id": "vision-model",
  "name": "Vision model",
  "input": ["text", "image"],
  "contextWindow": 32768,
  "maxTokens": 4096
}
```

Only declare capabilities that the endpoint actually supports. In particular, tool calling, image input, reasoning controls, and streaming behavior vary among OpenAI-compatible servers.

## Troubleshooting

- Open `/model` after changing `models.json`; Pi reloads the custom model configuration there.
- Ensure the API key environment variable is set in the same shell that starts Pi.
- Confirm the endpoint supports **Chat Completions** and streaming, not only the OpenAI Responses API.
- Check that `baseUrl` ends at the API version root, normally `/v1`.
- Verify the model ID with the endpoint's model-list API or its server logs.
- If tool calls or image attachments fail, use a model/server that supports those features or remove unsupported capability metadata.
