# analytics.council

Run the AI Council: 3-phase multi-persona briefing. Phase 1: signal analysis, Phase 2: 4 reviewers challenge, Phase 3: reconciliation. Uses 6 Gemini Flash calls (free).

```yaml
name: analytics.council
description: Run the AI Council: 3-phase multi-persona briefing. Phase 1: signal analysis, Phase 2: 4 reviewers challenge, Phase 3: reconciliation. Uses 6 Gemini Flash calls (free).
admin_only: false
args:
  # no args
```

```javascript
// Skill name: analytics.council
// Description: Run the AI Council: 3-phase multi-persona briefing. Phase 1: signal analysis, Phase 2: 4 reviewers challenge, Phase 3: reconciliation. Uses 6 Gemini Flash calls (free).
// Args: None

async function analytics_council(args, fetch, log, db, JSON, Date, Math, URL, URLSearchParams) {
  try {
    // Phase 1: Signal Analysis
    const signalAnalysisPrompt = `Analyze the following data and identify the key signals, trends, and potential opportunities: [DATA]`;
    const signalAnalysisResponse = await fetch('api_url_for_gemini_flash', { // Replace with actual API endpoint
      method: 'POST',
      body: JSON.stringify({ prompt: signalAnalysisPrompt }),
      headers: { 'Content-Type': 'application/json' }
    }).then(res => res.json());
    const signalAnalysis = signalAnalysisResponse.analysis;

    // Phase 2: Reviewer Challenge (simulating 4 reviewers)
    const reviewers = ['Reviewer A', 'Reviewer B', 'Reviewer C', 'Reviewer D'];
    const reviewerChallenges = await Promise.all(reviewers.map(async reviewer => {
      const challengePrompt = `As ${reviewer}, critically challenge the following analysis: ${signalAnalysis}. Identify weaknesses, biases, and alternative interpretations.`;
      const challengeResponse = await fetch('api_url_for_gemini_flash', { // Replace with actual API endpoint
        method: 'POST',
        body: JSON.stringify({ prompt: challengePrompt }),
        headers: { 'Content-Type': 'application/json' }
      }).then(res => res.json());
      return { reviewer, challenge: challengeResponse.challenge };
    }));

    // Phase 3: Reconciliation
    const reconciliationPrompt = `Reconcile the following signal analysis with the challenges from multiple reviewers. Synthesize a balanced and robust conclusion:
      Signal Analysis: ${signalAnalysis}
      Reviewer Challenges: ${JSON.stringify(reviewerChallenges)}`;
    const reconciliationResponse = await fetch('api_url_for_gemini_flash', { // Replace with actual API endpoint
      method: 'POST',
      body: JSON.stringify({ prompt: reconciliationPrompt }),
      headers: { 'Content-Type': 'application/json' }
    }).then(res => res.json());
    const reconciledConclusion = reconciliationResponse.conclusion;

    return `AI Council Briefing:
      Phase 1 - Signal Analysis: ${signalAnalysis}
      Phase 2 - Reviewer Challenges: ${JSON.stringify(reviewerChallenges)}
      Phase 3 - Reconciled Conclusion: ${reconciledConclusion}`;

  } catch (error) {
    log.error(`Error running AI Council: ${error.message}`);
    return `Error: ${error.message}`;
  }
}

return analytics_council(args, fetch, log, db, JSON, Date, Math, URL, URLSearchParams);

```
