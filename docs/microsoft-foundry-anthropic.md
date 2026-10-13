# Microsoft Foundry Anthropic Endpoints

Pi can connect to Microsoft Foundry deployments that expose the Anthropic Messages API. Configure the endpoint as a custom provider in Pi's user agent directory.

## Prerequisites

- A Microsoft Foundry resource and a deployed Anthropic model.
- The resource endpoint and API key.
- A current Pi installation.

## Configure Pi

Create or update `~/.pi/agent/models.json`. Merge this provider into the existing `providers` object if the file already exists:

```json
{
  "providers": {
    "foundry-anthropic": {
      "baseUrl": "https://YOUR-RESOURCE.services.ai.azure.com/anthropic",
      "api": "anthropic-messages",
      "apiKey": "$FOUNDRY_API_KEY",
      "models": [
        {
          "id": "YOUR-CLAUDE-DEPLOYMENT-NAME",
          "name": "Claude via Microsoft Foundry"
        }
      ]
    }
  }
}
```

Set the API key before starting Pi:

```bash
export FOUNDRY_API_KEY="your-foundry-api-key"
pi
```

Open `/model` in Pi and select the `foundry-anthropic` model.

## Endpoint and model values

- Replace `YOUR-RESOURCE` with the Foundry resource name.
- Replace `YOUR-CLAUDE-DEPLOYMENT-NAME` with the deployed model's deployment name.
- Use the Anthropic-compatible endpoint shown by Microsoft Foundry. Do not add `/v1/messages`; Pi's `anthropic-messages` API implementation supplies the request path.

## Authentication

The example uses a Foundry API key through the `FOUNDRY_API_KEY` environment variable, keeping the secret out of `models.json`.

Microsoft Entra ID authentication may need a custom Pi provider extension if the Foundry endpoint does not accept an API key or requires a token acquisition flow not supported by Pi's static provider configuration.

## Troubleshooting

If the model does not appear in `/model`, verify that `FOUNDRY_API_KEY` is set in the shell that starts Pi and that `models.json` is valid JSON. If requests fail, confirm the resource URL, API version requirements, deployment name, and that the deployed model exposes the Anthropic Messages API.
