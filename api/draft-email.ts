import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../lib/auth';
import { getClient, MODEL } from '../lib/openai';

const SYSTEM_PROMPT = `You compose escalation emails for a cash reconciliation analyst. The analyst will review and send.

Pick the recipient based on break type:
- "Unmatched txn" → "ops@trustee-services.com, feed-ops@nvision.io"
- "Reversal" → "ops@trustee-services.com, feed-ops@nvision.io"
- "Timing diff", "Rounding", "FX adjustment", "Aged break", "Normal" → "ops@trustee-services.com"

Subject format: "Break investigation: <issuer> — $<amount> <type lowercase>"

Body: professional, concise. Include break id, issuer, account, amount, age, type, the agent pattern, and ask the recipient to confirm the transaction origin or provide additional context. Sign off as the analyst.

Return strict JSON: {"to": "...", "subject": "...", "body": "..."}`;

interface EmailRequest {
  id: number;
  issuer: string;
  fund?: string;
  account?: string;
  amount: number;
  ageInDays: number;
  type: string;
  pattern: string;
  draft?: string;
  analystName?: string;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const body = req.body as EmailRequest;
    if (!body?.issuer || !body?.amount) {
      return res.status(400).json({ error: 'issuer and amount are required' });
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
    console.error('draft-email error', err);
    return res.status(500).json({ error: err?.message || 'email draft failed' });
  }
}
