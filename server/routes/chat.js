const express = require('express');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const { validateTemplate } = require('../services/templateValidator');

const router = express.Router();
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// Balanced-cost tier as of mid-2026 ("Terra"). Swap to the flagship
// (e.g. the "Sol" tier) if you want stronger reasoning for tricky template
// requests, or a cheaper/faster tier ("Luna") for high-volume chat traffic.
// Check https://platform.openai.com/docs/models for current model IDs if
// this one has been deprecated by the time you're reading this.
const CHAT_MODEL = process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-terra';

const SYSTEM_PROMPT = fs.readFileSync(
  path.join(__dirname, '../prompts/templateAgentSystemPrompt.md'),
  'utf-8'
);

const EMIT_TOOL = {
  type: 'function',
  function: {
    name: 'emit_template_spec',
    description: 'Emit the finished, Karix-shaped WhatsApp template spec once all required info has been gathered from the user.',
    parameters: {
      type: 'object',
      properties: {
        template_name: { type: 'string' },
        language: { type: 'string' },
        category: { type: 'string', enum: ['AUTHENTICATION', 'UTILITY', 'MARKETING'] },
        components: { type: 'array', items: { type: 'object' } },
      },
      required: ['template_name', 'language', 'category', 'components'],
    },
  },
};

/**
 * POST /api/chat
 * body: { sessionId, message, history: [{role, content}, ...] }
 *
 * Stateless-ish for simplicity — the caller (frontend) resends history each
 * turn. Swap in DB-backed chat_sessions/chat_messages persistence once the
 * auth layer is wired up (see server/db/schema.sql).
 */
router.post('/chat', async (req, res) => {
  const { message, history = [] } = req.body;
  if (!message) return res.status(400).json({ error: 'message is required' });

  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    ...history,
    { role: 'user', content: message },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: CHAT_MODEL,
      reasoning_effort: 'none', // reasoning + function tools isn't supported together on
                                  // /v1/chat/completions for reasoning-tier models like gpt-5.6-*;
                                  // this agent's job (slot-filling a template) doesn't need deep
                                  // reasoning anyway. Remove this line (and switch to the /v1/responses
                                  // API instead, which does support reasoning + tools) if you want the
                                  // model reasoning harder about ambiguous requests later.
      messages,
      tools: [EMIT_TOOL],
    });

    const choice = response.choices[0].message;
    const toolCall = (choice.tool_calls || []).find((tc) => tc.function.name === 'emit_template_spec');
    const textReply = choice.content || '';

    if (toolCall) {
      let spec;
      try {
        spec = JSON.parse(toolCall.function.arguments);
      } catch (e) {
        return res.status(502).json({ error: 'model_returned_invalid_json', detail: toolCall.function.arguments });
      }

      const { valid, errors, warnings } = validateTemplate(spec);
      return res.json({
        reply: textReply || 'Here is the template I put together based on what you told me.',
        spec,
        validation: { valid, errors, warnings },
        // frontend should render a WhatsApp-style preview here and only call
        // POST /api/templates/submit once the user explicitly approves it.
      });
    }

    return res.json({ reply: textReply });
  } catch (err) {
    console.error('chat error', err);
    res.status(500).json({ error: 'chat_failed', detail: err.message });
  }
});

module.exports = router;
