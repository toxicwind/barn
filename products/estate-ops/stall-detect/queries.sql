-- ============================================================================
-- stall-detect/queries.sql — DB-forensics stall-detection query pack
--
-- Permanent companion to the stall-slayer runbook (README.md in this dir).
-- Execution path: any agent with the muse_db skill runs these via `muse.db`
-- (bounded, read-only SELECT; the DB is tool-gated, so there is no shell CLI).
-- All queries use only the functions/casts the muse.db surface allows and
-- return ≤50 rows each. Read references/schema.md before modifying.
--
-- Lane rule: this pack is DB forensics ONLY (executions, tool calls,
-- transcripts, mailbox, recovery). Live process behavior (ps, CPU, py-spy,
-- strace, ports) belongs to the live-proc lane (stale-hunter) — do not
-- duplicate their hunt; share DB findings in fleet and divide targets there.
--
-- Q8/Q9/Q10 are the error-claim harvest: raw error-shaped strings are CLAIMS,
-- not facts (unreliable-narrator doctrine). Feed harvest results to
-- `agent-reaper --classify-errors` (JSON array of {id, source, error_text}),
-- which classifies each claim against the shared ERROR_CLAIM_CATALOG
-- (hatch/bin/error_claims.py) and prints an executable cause->verify->action
-- report. Never act on an error string before classify+verify.
-- ============================================================================

-- Q1: stale running agents — idle > 12h (tune threshold per fleet needs)
SELECT agent_id AS stale_aid, kind AS k, agent_type AS atype,
       round((EXTRACT(epoch FROM now()) - updated_at)/3600, 1) AS idle_hrs,
       substr(last_assistant_message, 1, 300) AS last_msg
FROM agent.agents
WHERE status = 'running'
  AND (EXTRACT(epoch FROM now()) - updated_at) > 12*3600
ORDER BY updated_at ASC
LIMIT 50;

-- Q2: in-flight tool calls with NO output — genuinely stuck mid-call work
SELECT c.tool_name AS tname, c.status AS s, c.call_id AS tcall,
       round((EXTRACT(epoch FROM now()) - EXTRACT(epoch FROM c.created_at))/3600, 1) AS age_hrs
FROM runtime.tool_calls c
LEFT JOIN runtime.tool_outputs o ON o.call_id = c.call_id
WHERE o.call_id IS NULL
ORDER BY c.created_at ASC
LIMIT 50;

-- Q3: mailbox backlog — submissions accepted/attached but never
-- terminalized, older than 1h (fresh ones <1h are normal traffic)
SELECT submission_id AS sid, agent_id AS aid, state AS s,
       submission_kind AS kind,
       round((EXTRACT(epoch FROM now()) - EXTRACT(epoch FROM accepted_at))/3600, 1) AS age_hrs
FROM agent.message_mailbox
WHERE state IN ('accepted', 'attached')
  AND (EXTRACT(epoch FROM now()) - EXTRACT(epoch FROM accepted_at)) > 3600
ORDER BY accepted_at ASC
LIMIT 50;

-- Q4: unterminalized recovery owners — recovery sessions that never closed
SELECT recovery_class AS rc, agent_id AS aid, message_id AS mid,
       round((EXTRACT(epoch FROM now()) - EXTRACT(epoch FROM active_at))/3600, 1) AS age_hrs
FROM agent.recovery_owners
WHERE terminal_at IS NULL
ORDER BY active_at ASC
LIMIT 50;

-- Q5: errored agents + their final message (root-cause seed)
SELECT agent_id AS aid, kind AS k,
       round((EXTRACT(epoch FROM now()) - updated_at)/3600, 1) AS idle_hrs,
       substr(last_assistant_message, 1, 300) AS last_msg
FROM agent.agents
WHERE status = 'errored'
ORDER BY updated_at DESC
LIMIT 20;

-- Q6: transcript tail for ONE stale agent (substitute <AGENT_ID>)
SELECT seq AS s, item_kind AS kind, role AS r, tool_name AS tname,
       substr(text_content, 1, 300) AS txt
FROM agent.context_items
WHERE agent_id = '<AGENT_ID>'
ORDER BY seq DESC
LIMIT 20;

-- Q7: ownership trace for ONE stale agent (who spawned it? still has owner?)
SELECT spawn_id AS sid, parent_agent_id AS parent,
       requester_source AS src, status AS s,
       substr(prompt, 1, 300) AS prompt_head
FROM agent.subagent_spawns
WHERE child_agent_id = '<AGENT_ID>'
LIMIT 5;

-- Q8: error-claim harvest — error-shaped strings in agent final messages.
-- Most hits are completed agents whose final reports merely MENTION errors
-- (e.g. "10 Mistral + 1 Gemini + 4 OpenRouter failures") — not error claims
-- about stalls. Classify with `agent-reaper --classify-errors` before acting.
SELECT agent_id AS aid, status AS s, kind AS k,
       round((EXTRACT(epoch FROM now()) - updated_at)/3600, 1) AS idle_hrs,
       substr(last_assistant_message, 1, 300) AS claim_txt
FROM agent.agents
WHERE last_assistant_message IS NOT NULL
  AND (lower(last_assistant_message) LIKE '%error%'
    OR lower(last_assistant_message) LIKE '%failed%'
    OR lower(last_assistant_message) LIKE '%timeout%'
    OR lower(last_assistant_message) LIKE '%refused%'
    OR lower(last_assistant_message) LIKE '%denied%'
    OR lower(last_assistant_message) LIKE '%no space%'
    OR lower(last_assistant_message) LIKE '%unauthorized%'
    OR lower(last_assistant_message) LIKE '%429%'
    OR lower(last_assistant_message) LIKE '%401%')
ORDER BY updated_at DESC
LIMIT 50;

-- Q9: error-claim harvest — failed tool outputs (canonical DB lane).
-- NOTE (verified 2026-09-20): runtime.tool_calls and runtime.tool_outputs
-- are EMPTY in this cell's muse.db view, so this returns 0 rows here. Where
-- populated, this is the primary failed-output lane; otherwise use Q10.
-- Classify results with `agent-reaper --classify-errors` before acting.
SELECT o.call_id AS tcall,
       substr(coalesce(o.error_text, o.output_text), 1, 300) AS claim_txt
FROM runtime.tool_outputs o
WHERE o.error_text IS NOT NULL
ORDER BY o.event_seq DESC
LIMIT 50;

-- Q10: error-claim harvest — failed tool events (the populated lane here).
-- agent.subagent_progress_tool_events carries tool_status='failed' rows with
-- tool_result_preview (1,185 on 2026-09-20). Genuine tool failures
-- (exit 1, edit mismatch, browser action failed) usually return NO catalog
-- claim from the classifier — that is correct: a failed tool is not a
-- misleading error claim. Only act on claims the classifier recognizes.
SELECT tool_name AS tname, tool_status AS s, child_agent_id AS aid,
       substr(tool_result_preview, 1, 300) AS claim_txt
FROM agent.subagent_progress_tool_events
WHERE tool_status = 'failed'
ORDER BY event_id DESC
LIMIT 50;
