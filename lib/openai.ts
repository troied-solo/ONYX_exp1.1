import { AzureOpenAI } from 'openai';

let _client: AzureOpenAI | null = null;

/**
 * Returns a singleton Azure OpenAI client. Reads config from env vars on first call:
 *   AZURE_OPENAI_API_KEY      — Azure OpenAI resource key
 *   AZURE_OPENAI_ENDPOINT     — e.g. https://genaitraining-aoai2.openai.azure.com
 *                               (without /openai — the SDK adds that)
 *   AZURE_OPENAI_API_VERSION  — e.g. 2025-03-01-preview (defaults to that)
 */
export function getClient(): AzureOpenAI {
  if (_client) return _client;

  const apiKey = process.env.AZURE_OPENAI_API_KEY;
  const endpoint = process.env.AZURE_OPENAI_ENDPOINT;
  const apiVersion = process.env.AZURE_OPENAI_API_VERSION || '2025-03-01-preview';

  if (!apiKey) throw new Error('AZURE_OPENAI_API_KEY is not set');
  if (!endpoint) throw new Error('AZURE_OPENAI_ENDPOINT is not set');

  _client = new AzureOpenAI({ apiKey, endpoint, apiVersion });
  return _client;
}

/**
 * The Azure DEPLOYMENT name (not the OpenAI model name).
 * In your tenant this is `gpt-4.1` per the API screenshot.
 */
export const MODEL = process.env.AZURE_OPENAI_DEPLOYMENT || 'gpt-4.1';
