import { useState, useCallback, useRef } from 'react';
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

  const triageEmails = useCallback(
    async (mails: MailItem[]): Promise<TriageResult[]> => {
      setLoading(true);
      setError(null);
      const opId = `triage-${Date.now()}`;
      operationIdRef.current = opId;
      try {
        const results = await window.electronAPI.triageEmails(mails, apiKey);
        setResult(results);
        return results;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return [];
      } finally {
        setLoading(false);
        operationIdRef.current = null;
      }
    },
    [apiKey],
  );

  const extractTodos = useCallback(
    async (threadMessages: ThreadMessage[]): Promise<TodoItem[]> => {
      setLoading(true);
      setError(null);
      const opId = `todos-${Date.now()}`;
      operationIdRef.current = opId;
      try {
        const results = await window.electronAPI.extractTodos(
          threadMessages,
          apiKey,
        );
        setResult(results);
        return results;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        return [];
      } finally {
        setLoading(false);
        operationIdRef.current = null;
      }
    },
    [apiKey],
  );

  const runHistoricalAudit = useCallback(
    async (params: AuditParams): Promise<AuditResult> => {
      setLoading(true);
      setError(null);
      setCostUsd(0);
      const opId = `audit-${Date.now()}`;
      operationIdRef.current = opId;
      try {
        const auditResult =
          await window.electronAPI.startHistoricalAudit(params);
        setResult(auditResult);
        setCostUsd(
          (auditResult as AuditResult & { costUsd?: number }).costUsd ?? 0,
        );
        return auditResult;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setError(message);
        throw err;
      } finally {
        setLoading(false);
        operationIdRef.current = null;
      }
    },
    [],
  );

  const cancel = useCallback(async () => {
    const opId = operationIdRef.current;
    if (opId) {
      await window.electronAPI.cancelOperation(opId);
      operationIdRef.current = null;
      setLoading(false);
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
