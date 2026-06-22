import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../lib/auth';
import { getClient, MODEL } from '../lib/openai';

const SYSTEM_PROMPT = `You are drafting a resolution recommendation for a cash reconciliation analyst reviewing a single break exception.

Write a 2-3 sentence recommendation that:
1. States the break amount and classification plainly.
2. Explains the likely cause using the pattern provided.
3. Recommends a specific next action — for example: "expected to auto-clear by <date>", "escalate to Trustee operations", "apply tolerance rule", "manual reversal confirmation needed".

Tone: factual, specific, professional. No filler, no apologies, no "based on the above". Reference actual dates and amounts from the input.

Return strict JSON: {"draft": "..."}`;

interface DraftRequest {
  amount: number;
  type: string;
  ageInDays: number;
  pattern: string;
  input: 'Trustee' | 'nVision';
  asOfDate: string;
  valueDate?: string;
  settleDate?: string;
  description: string;
  matchedInOtherSource: boolean;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const body = req.body as DraftRequest;
    if (!body?.amount || !body?.type) {
      return res.status(400).json({ error: 'amount and type are required' });
    }

    const completion = await getClient().chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.3,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify(body) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'empty completion' });

    return res.status(200).json(JSON.parse(content));
  } catch (err: any) {
    console.error('draft-resolution error', err);
    return res.status(500).json({ error: err?.message || 'draft failed' });
  }
}
