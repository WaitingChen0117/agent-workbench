'use client';

import { useState } from "react";
import {
  Alert,
  Button,
  Card,
  InputNumber,
  message,
  Space,
  Typography,
  Upload,
} from 'antd';
import { InboxOutlined } from '@ant-design/icons';

import type {UploadProps} from 'antd';
import type { TextChunk } from "@/lib/rag/chunk";

const { Dragger } = Upload;

interface DocumentInfo {
    fileName: string;
    fileType: string;
    fileSize: number;
    characterCount: number;
    chunkCount: number;
}

interface UploadResult {
    document: DocumentInfo;
    chunks: TextChunk[];
}

export default function KnowledgeUploader() {
    const [file, setFile] = useState<File | null>(null);
    const [chunkSize, setChunkSize] = useState(500);
    const [overlap, setOverlap] = useState(100);
    const [loading, setLoading] = useState(false);
    const [result, setResult] = useState<UploadResult | null>(null);

    const [messageApi, contextHolder] = message.useMessage();

    const uploadProps: UploadProps = {
        accept: '.txt, .md',
        maxCount: 1,
        beforeUpload: (selectedFile) => {
            setFile(selectedFile);
            setResult(null);
            return false;
        },
        onRemove: () => {
            setFile(null);
            setResult(null);
        }
    }

    const handleUpload = async () => {
        if(!file) {
            messageApi.warning('请先选择文件');
            return;
        }

        if(!Number.isInteger(chunkSize) || !Number.isInteger(overlap) || chunkSize <=0 || overlap < 0 || overlap >= chunkSize) {
            messageApi.warning('请检查文本切分参数');
            return;
        }

        const formData = new FormData();

        formData.append('file', file);
        formData.append('chunkSize', String(chunkSize));
        formData.append('overlap', String(overlap));

        setLoading(true);
        setResult(null);

        try {
            const response = await fetch('/api/knowledge/upload', {
                method: 'POST',
                body: formData,
            })

            const data = await response.json();

            if(!response.ok) {
                throw new Error(data.error || '上传失败');
            }

            setResult({
                document: data.document,
                chunks: data.chunks,
            });

            messageApi.success('文档解析成功');
        } catch (error) {
            messageApi.error(error instanceof Error ? error.message : '上传失败')
        } finally {
            setLoading(false);
        }
    }

    return (
        <div style={{ maxWidth: 1000, margin: '0 auto', padding: 24 }}>
            {contextHolder}

            <Typography.Title level={3}>
                个人知识库
            </Typography.Title>

            <Typography.Paragraph type="secondary">
                上传 TXT 或 Markdown 文档，查看文本解析和分块结果。
            </Typography.Paragraph>

            <Card title="上传文档">
                <Dragger {...uploadProps}>

                <p className="ant-upload-drag-icon">
                    <InboxOutlined />
                </p>

                <p className="ant-upload-text">
                    点击或拖拽文件到这里
                </p>

                <p className="ant-upload-hint">
                    当前支持 TXT、Markdown，文件最大 5MB
                </p>

                </Dragger>

                <Space wrap style={{ marginTop: 20 }}>

                <span>分块大小：</span>

                <InputNumber
                    min={1}
                    max={5000}
                    value={chunkSize}
                    onChange={(value) => setChunkSize(value ?? 500)}
                />

                <span>重叠字符数：</span>

                <InputNumber
                    min={0}
                    max={4999}
                    value={overlap}
                    onChange={(value) => setOverlap(value ?? 100)}
                />

                <Button
                    type="primary"
                    loading={loading}
                    onClick={handleUpload}
                >
                    上传并解析
                </Button>
                </Space>
            </Card>

            {result && (
                <>
                    <Card title="解析结果" style={{ marginTop: 24 }}>
                        <Space direction="vertical">

                        <Typography.Text>
                            文件名：{result.document.fileName}
                        </Typography.Text>

                        <Typography.Text>
                            文件大小：
                            {(result.document.fileSize / 1024).toFixed(2)} KB
                        </Typography.Text>

                        <Typography.Text>
                            文本字符数：{result.document.characterCount}
                        </Typography.Text>

                        <Typography.Text>
                            分块数量：{result.document.chunkCount}
                        </Typography.Text>
                        </Space>
                    </Card>

                    <Typography.Title level={4} style={{ marginTop: 24 }}>
                        文本分块预览
                    </Typography.Title>

                    {result.chunks.map((chunk) => (
                        <Card
                            key={chunk.id}
                            size="small"
                            title={`Chunk ${chunk.index + 1}`}
                            style={{ marginBottom: 12 }}
                        >

                        <Alert
                            type="info"
                            showIcon={false}
                            message={`字符范围：${chunk.start} - ${chunk.end}`}
                            style={{ marginBottom: 12 }}
                        />

                        <Typography.Paragraph
                            style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}
                        >
                            {chunk.content}
                        </Typography.Paragraph>
                        </Card>
                    ))}
                </>
            )}
        </div>
    )
}