// src/scout/analyze.js — AI Picks: sends top products to Claude for verdicts

const Analyze = {
  async run(products, apiKey) {
    if (!apiKey) return { success: false, error: 'No Anthropic API key saved (set it on the Home screen)' };
    if (!products?.length) return { success: false, error: 'No products to analyze' };

    const top = products.slice(0, 40).map(p => ({
      asin: p.asin || null, title: p.title.slice(0, 90), amazonPrice: p.price || null,
      reviews: p.reviews || null, score: p.score,
      ebayPrice: p.ebayLowest ?? null, ebayCompetitors: p.ebayCount ?? null,
      sold30d: p.sold30d ?? null, sold7d: p.sold7d ?? null,
      marginAfterFees: p.margin ?? null, signalSource: p.source || 'hunt',
    }));

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 3000,
        messages: [{
          role: 'user',
          content: `You are an expert Amazon-to-eBay dropshipping analyst. For each item below, give a verdict: STRONG BUY, BUY, WATCH, or SKIP, with one short reason (max 15 words). Weigh signals in this order: observed eBay sales (sold30d/sold7d = real demand), margin after fees, competitor count, reviews, VeRO/brand risk, seasonality, fragility/shipping risk. signalSource tells you where the item came from: "competitor:<seller>" = another dropshipper sold these (strongest), "movers:" = Amazon rank spike, "keyword" = market probe (title is a search term, not a specific product), "hunt" = keyword search. Items without asin can still be judged as niches.

Products (JSON):
${JSON.stringify(top, null, 1)}

Reply with ONLY a JSON array: [{"asin":"...or null","title":"first 30 chars of the title","verdict":"BUY","reason":"..."}]`
        }]
      })
    });

    if (!res.ok) return { success: false, error: `API ${res.status}: ${(await res.text()).slice(0, 200)}` };
    const data = await res.json();
    const text = data.content?.[0]?.text || '';
    const match = text.match(/\[[\s\S]*\]/);
    if (!match) return { success: false, error: 'Could not parse AI response' };
    try {
      return { success: true, picks: JSON.parse(match[0]) };
    } catch (e) {
      return { success: false, error: 'Bad JSON from AI: ' + e.message };
    }
  }
};

module.exports = Analyze;
