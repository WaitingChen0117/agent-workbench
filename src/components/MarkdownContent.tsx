'use client';

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { Prism as SyntaxHighlighter } from 'react-syntax-highlighter';
import { oneDark } from 'react-syntax-highlighter/dist/esm/styles/prism';

interface MarkdownContextProps {
    content: string;
}

export default function MarkdownContent({
    content,
}: MarkdownContextProps) {
    return (
        <div className='markdown-content'>
            <ReactMarkdown
                remarkPlugins={[remarkGfm]}
                components={{
                    pre({ children }) {
                        return <>{children}</>;
                    },
                    code({ className, children, ...props }) {
                        const match = /language-(\w+)/.exec(className || '');
                        const language = match?.[1];
                        const code = String(children).replace(/\n$/, '');
                        if (language) {
                            return (
                                <SyntaxHighlighter
                                    language={language}
                                    style={oneDark}
                                    PreTag="div"
                                    wrapLongLines
                                >
                                    {code}
                                </SyntaxHighlighter>
                            );
                        }

                        return (
                            <code className={className} {...props}>
                                {children}
                            </code>
                        );
                    },
                }}
            >
                {content}
            </ReactMarkdown>
        </div>
    )
}