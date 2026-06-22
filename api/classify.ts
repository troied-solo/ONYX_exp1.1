import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireAuth } from '../lib/auth';
import { getClient, MODEL } from '../lib/openai';

const SYSTEM_PROMPT = `You are a cash reconciliation analyst classifying break exceptions between a Trustee system and an nVision accounting system.

For each break in the input array, classify it into exactly one of these types:
- "Timing diff" — present in one source, missing in the other, age ≤ 5 days, expected to settle (T+N behaviour)
- "Rounding" — small absolute amount (< $100) consistent with rounding/FX precision differences
- "Unmatched txn" — present in one source only, no matching counterpart in the other, age > 3 days
- "Reversal" — negative amount that looks like a reversal not yet processed on the other side
- "FX adjustment" — FX or currency conversion artefact
- "Aged break" — open > 14 days and doesn't cleanly fit another category
- "Normal" — minor, expected, no action needed

For each break, return:
- type: one of the labels above (exact string)
- confidence: integer 0-100 reflecting how certain you are
- pattern: 1-2 sentences explaining WHY this break exists, using specifics from the data
- severity: "critical" | "warning" | "normal" — critical for large unmatched/reversal/aged-and-large; warning for medium-impact timing or rounding; normal for clean expected timing
- priority: "Critical" | "High" | "Normal" — derived from severity + amount + age

Return strict JSON in this shape, in the SAME ORDER as the input breaks:
{"classifications":[{"id":<id>,"type":"...","confidence":91,"pattern":"...","severity":"warning","priority":"High"}, ...]}`;

interface ClassifyRequest {
  breaks: Array<{
    id: number;
    amount: number;
    asOfDate: string;
    valueDate?: string;
    settleDate?: string;
    input: 'Trustee' | 'nVision';
    description: string;
    issuer?: string;
    ageInDays: number;
    matchedInOtherSource: boolean;
    counterpartHints?: string;
  }>;
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'POST only' });
  }
  if (!requireAuth(req, res)) return;

  try {
    const body = req.body as ClassifyRequest;
    if (!body?.breaks || !Array.isArray(body.breaks) || body.breaks.length === 0) {
      return res.status(400).json({ error: 'breaks[] is required' });
    }
    if (body.breaks.length > 25) {
      return res.status(400).json({ error: 'send at most 25 breaks per request' });
    }

    const completion = await getClient().chat.completions.create({
      model: MODEL,
      response_format: { type: 'json_object' },
      temperature: 0.2,
      messages: [
        { role: 'system', content: SYSTEM_PROMPT },
        { role: 'user', content: JSON.stringify({ breaks: body.breaks }) },
      ],
    });

    const content = completion.choices[0]?.message?.content;
    if (!content) return res.status(502).json({ error: 'empty completion' });

    const parsed = JSON.parse(content);
    return res.status(200).json(parsed);
  } catch (err: any) {
    console.error('classify error', err);
    return res.status(500).json({ error: err?.message || 'classify failed' });
  }
}
