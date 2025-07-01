import { EditorEngineProvider } from '@/components/store/editor';
import { Main } from './_components/main';
import { ChatProvider } from './_hooks/use-chat';

export default async function Page({ params }: { params: Promise<{ id: string }> }) {
    const projectId = (await params).id;
    if (!projectId) {
        return <div>Invalid project ID</div>;
    }

    return (
        <EditorEngineProvider projectId={projectId}>
            <ChatProvider>
                <Main />
            </ChatProvider>
        </EditorEngineProvider>
    );
}
