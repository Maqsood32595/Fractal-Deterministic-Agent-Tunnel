# AgentTunnel Complex Testing — Micro Steps
This document outlines the four complex testing scenarios to run on the scout-kernel-poc codebase to validate the AgentTunnel architecture.

## Test 1: Remote SSH Telemetry Agent (The "Read-Only SRE")
- [ ] Create `ssh-telemetry` feature folder and `feature.manifest.json`.
- [ ] Whitelist `ssh` commands for `top`, `free`, and `df` in Regex.
- [ ] Forbid dangerous keywords (`rm`, `reboot`, `wget`).
- [ ] Write a test worker script that successfully requests a safe SSH command.
- [ ] Write a malicious test worker script that attempts to inject a destructive SSH command.
- [ ] Verify Gateway blocks the malicious attempt.

## Test 2: PostgreSQL Migration & Tuning Agent
- [ ] Create `pg-tuner` feature folder and `feature.manifest.json`.
- [ ] Whitelist `psql -c "SELECT ..."` and `EXPLAIN`.
- [ ] Forbid `DROP`, `ALTER`, `TRUNCATE`, `DELETE`.
- [ ] Write test script simulating safe index creation/query analysis.
- [ ] Write malicious script attempting a `DROP TABLE` injection.
- [ ] Verify Gateway intercepts and blocks the destructive query.

## Test 3: GCP Secrets Manager Automator
- [ ] Create `gcp-secrets-manager` feature folder and `feature.manifest.json`.
- [ ] Whitelist `gcloud secrets versions add` and `access`.
- [ ] Forbid `delete` or `destroy` actions.
- [ ] Simulate a multi-step secret rotation pipeline.
- [ ] Verify Gateway blocks unauthorized deletion attempts.

## Test 4: The "Self-Healing Server" Loop
- [ ] Create `self-healing-monitor` feature folder and `feature.manifest.json`.
- [ ] Whitelist `pm2 restart scout-kernel` or specific `kill -9 [exact_pid]`.
- [ ] Forbid generic `kill -9 1` or global shutdown commands.
- [ ] Write a loop script that monitors simulated memory.
- [ ] Verify the Gateway strictly traps the reboot action to the designated application only.
