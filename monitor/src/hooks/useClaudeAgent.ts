import { useState, useCallback, useRef, useEffect } from 'react';
import type {
  MailItem,
  ThreadMessage,
  AuditParams,
  TriageResult,
  TodoItem,
  AuditResult,
} from '../types';

interface ClaudeAgentHook {
  result: unknown;
  loading: boolean;
  error: string | null;
  costUsd: number;
  triageEmails: (mails: MailItem[]) => Promise<TriageResult[]>;
  extractTodos: (threadMessages: ThreadMessage[]) => Promise<TodoItem[]>;
  runHistoricalAudit: (params: AuditParams) => Promise<AuditResult>;
  cancel: () => Promise<void>;
}

export function useClaudeAgent(apiKey: string): ClaudeAgentHook {
  const [result, setResult] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [costUsd, setCostUsd] = useState(0);
  const operationIdRef = useRef<string | null>(null);

  // Generation token: bumped on every new operation AND on cancel/unmount.
  // The async handlers capture their generation and refuse to commit state if
  // it has since been superseded — so a cancelled or stale operation can no
  // longer overwrite `result` / `error` / `loading` once it eventually resolves.
  const runIdRef = useRef(0);
  // AbortController for the active operation. cancel() aborts it so the
  // post-await state-writing path short-circuits immediately. (The signal is
  // also the natural thing to forward to main once cancellation is wired up.)
  const abortRef = useRef<AbortController | null>(null);

  // Abort any in-flight operation when the component unmounts.
  useEffect(() => {
    return () => {
      runIdRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  // Begin a new operation: supersede any previous generation, set up a fresh
  // AbortController, and return the generation id + signal for guarding.
  const beginOperation = useCallback((opId: string) => {
    runIdRef.current += 1;
    const myRunId = runIdRef.current;
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    operationIdRef.current = opId;
    return { myRunId, signal: controller.signal };
  }, []);

  // True only if this generation is still the active, non-aborted one.
  const isCurrent = useCallback((myRunId: number, signal: AbortSignal) => {
    return myRunId === runIdRef.current && !signal.aborted;
  }, []);

  const triageEmails = useCallback(
    async (mails: MailItem[]): Promise<TriageResult[]> => {
      const opId = `triage-${Date.now()}`;
      const { myRunId, signal } = beginOperation(opId);
      setLoading(true);
      setError(null);
      try {
        const results = await window.electronAPI.triageEmails(
          mails,
          apiKey,
          opId,
        );
        // Drop the result if this run was cancelled / superseded.
        if (!isCurrent(myRunId, signal)) return [];
        setResult(results);
        return results;
      } catch (err) {
        if (!isCurrent(myRunId, signal)) return [];
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return [];
      } finally {
        if (isCurrent(myRunId, signal)) {
          setLoading(false);
          operationIdRef.current = null;
        }
      }
    },
    [apiKey, beginOperation, isCurrent],
  );

  const extractTodos = useCallback(
    async (threadMessages: ThreadMessage[]): Promise<TodoItem[]> => {
      const opId = `todos-${Date.now()}`;
      const { myRunId, signal } = beginOperation(opId);
      setLoading(true);
      setError(null);
      try {
        const results = await window.electronAPI.extractTodos(
          threadMessages,
          apiKey,
          opId,
        );
        if (!isCurrent(myRunId, signal)) return [];
        setResult(results);
        return results;
      } catch (err) {
        if (!isCurrent(myRunId, signal)) return [];
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return [];
      } finally {
        if (isCurrent(myRunId, signal)) {
          setLoading(false);
          operationIdRef.current = null;
        }
      }
    },
    [apiKey, beginOperation, isCurrent],
  );

  const runHistoricalAudit = useCallback(
    async (params: AuditParams): Promise<AuditResult> => {
      const opId = `audit-${Date.now()}`;
      const { myRunId, signal } = beginOperation(opId);
      setLoading(true);
      setError(null);
      setCostUsd(0);
      try {
        const auditResult = await window.electronAPI.startHistoricalAudit(
          params,
          opId,
        );
        if (isCurrent(myRunId, signal)) {
          setResult(auditResult);
          setCostUsd(
            (auditResult as AuditResult & { costUsd?: number }).costUsd ?? 0,
          );
        }
        return auditResult;
      } catch (err) {
        if (isCurrent(myRunId, signal)) {
          const message = err instanceof Error ? err.message : String(err);
          setError(message);
        }
        throw err;
      } finally {
        if (isCurrent(myRunId, signal)) {
          setLoading(false);
          operationIdRef.current = null;
        }
      }
    },
    [beginOperation, isCurrent],
  );

  const cancel = useCallback(async () => {
    const opId = operationIdRef.current;

    // 1) Supersede the current generation and abort its controller so the
    //    in-flight handler's post-await path can no longer write state.
    runIdRef.current += 1;
    abortRef.current?.abort();
    abortRef.current = null;
    operationIdRef.current = null;

    // 2) Reset UI state immediately — the user asked to stop.
    setLoading(false);

    // 3) Tell main to actually stop the work. The operationId is forwarded to
    //    main on every triageEmails/extractTodos/startHistoricalAudit call,
    //    where it maps to an AbortController wired into the Agent SDK query —
    //    aborting it stops the underlying subprocess.
    if (opId) {
      try {
        await window.electronAPI.cancelOperation(opId);
      } catch {
        // best-effort; renderer state is already reset above
      }
    }
  }, []);

  return {
    result,
    loading,
    error,
    costUsd,
    triageEmails,
    extractTodos,
    runHistoricalAudit,
    cancel,
  };
}
