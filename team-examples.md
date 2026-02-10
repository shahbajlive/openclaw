# Team Examples

This file contains prompt templates to exercise different team topologies and message flow patterns.

## Sequential Headcount

Goal: teammates coordinate in strict order and report the final team strength.

Prompt:
```
Create a team of 10 and run a sequential headcount from 1 to 10. No one should miss. Report the total count at the end.
```

## Ring Passing

Goal: test cyclic routing and handoffs across the full team.

Prompt:
```
Create a team of 5 and run a ring pass twice. Each hop should include a counter. After two full loops, return the final summary.
```

## Fan Out and Fan In

Goal: parallel execution followed by aggregation.

Prompt:
```
Create a team of 4. Split the work into 4 subtasks, collect results, then summarize.
```

## Pipeline

Goal: staged processing where each teammate transforms the output of the previous stage.

Prompt:
```
Create a team of 3 and run a pipeline: draft input, clean/transform, then validate and summarize. Each stage passes output to the next. Report the final output.
```

## Debate Then Judge

Goal: adversarial comparison with a single adjudicator.

Prompt:
```
Create a team of 3 and run a debate: argue "A", argue "B", then judge with 2–3 reasons. Only the final judgment should be reported.
```

## Timed Relay Headcount

Goal: coordination with timestamps to measure latency and ordering.

Prompt:
```
Create a team of 5 and run a timed headcount relay. Start with "1 @<timestamp>", append number and timestamp at each hop, and return the full log at the end.
```
