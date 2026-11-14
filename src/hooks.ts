import { useCallback, useEffect, useRef, useState } from 'react';
import type { GenerationJob } from '@shared/types';
import { api } from './api';

type TerminalHandler = (job: GenerationJob) => void;

export function useJobStream(onFinished?: TerminalHandler) {
  const [job, setJob] = useState<GenerationJob | null>(null);
  const [output, setOutput] = useState('');
  const [running, setRunning] = useState(false);
  const sourceRef = useRef<EventSource | null>(null);
  const finishedRef = useRef<TerminalHandler | undefined>(onFinished);
  finishedRef.current = onFinished;

  const close = useCallback(() => {
    sourceRef.current?.close();
    sourceRef.current = null;
  }, []);

  const attach = useCallback(
    (next: GenerationJob) => {
      close();
      setJob(next);
      setOutput(next.output ?? '');
      const terminal = ['completed', 'failed', 'cancelled', 'interrupted'].includes(next.status);
      if (terminal) {
        setRunning(false);
        finishedRef.current?.(next);
        return;
      }

      setRunning(true);
      const source = new EventSource(api.jobStreamUrl(next.id));
      sourceRef.current = source;

      source.addEventListener('snapshot', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as {
            job: GenerationJob;
            output: string;
          };
          setJob(data.job);
          setOutput(data.output);
        } catch {
          // Ignore malformed events and keep the last known state.
        }
      });

      source.addEventListener('delta', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { text: string };
          setOutput((current) => current + data.text);
        } catch {
          // Ignore malformed events.
        }
      });

      source.addEventListener('status', (event) => {
        try {
          const data = JSON.parse((event as MessageEvent).data) as { job: GenerationJob };
          setJob(data.job);
          setOutput(data.job.output ?? '');
          if (['completed', 'failed', 'cancelled', 'interrupted'].includes(data.job.status)) {
            setRunning(false);
            close();
            finishedRef.current?.(data.job);
          }
        } catch {
          // Ignore malformed events.
        }
      });
    },
    [close],
  );

  const reset = useCallback(() => {
    close();
    setJob(null);
    setOutput('');
    setRunning(false);
  }, [close]);

  useEffect(() => () => close(), [close]);

  return { job, output, running, attach, reset };
}
