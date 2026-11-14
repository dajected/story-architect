import { useMemo } from 'react';
import { marked } from 'marked';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: true });

export function Markdown({ text, className = '' }: { text: string; className?: string }) {
  const html = useMemo(() => {
    const parsed = marked.parse(text, { async: false }) as string;
    return DOMPurify.sanitize(parsed, { USE_PROFILES: { html: true } });
  }, [text]);
  return <div className={`markdown ${className}`} dangerouslySetInnerHTML={{ __html: html }} />;
}
