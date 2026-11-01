// Synthetic examples shared by the landing build and its browser interactions.
export const sources = [
  '# Release plan\n\nA small release with a clear owner and a documented decision.\n\n## Rollout\n\nWe deploy a release every Friday after the checks finish.\n\nThe release owner publishes changes after the automated checks.\n',
  '# Release plan\n\nA small release with a clear owner and a documented decision.\n\n## Rollout\n\nWe deploy a release every day after the checks finish.\n\nThe release owner publishes changes after the automated checks and a written summary.\n',
  '# Release plan\n\nA small release with a clear owner and a documented decision.\n\n## Rollout\n\nWe deploy a release every day after the checks finish.\n\nThe release owner publishes changes after the automated checks, a human review and a written summary.\n',
];
export const diagramBefore = 'flowchart TB\n  draft[Draft] --> agent[Agent edit]\n  agent --> published([Published])\n';
export const diagramAfter = 'flowchart TB\n  draft[Draft] --> agent[Agent implements]\n  agent --> review{Human review}\n  review -->|Approved| published([Published])\n  review -->|Changes| agent\n';
