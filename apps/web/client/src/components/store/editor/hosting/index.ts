import { api } from '@/trpc/client';
import {
    PublishStatus,
    type DeploymentResponse,
    type PublishRequest,
    type PublishResponse,
    type PublishState
} from '@onlook/models';
import {
    type FreestyleFile,
} from 'freestyle-sandboxes';
import { makeAutoObservable } from 'mobx';

const DEFAULT_PUBLISH_STATE: PublishState = {
    status: PublishStatus.UNPUBLISHED,
    message: null,
    buildLog: null,
    error: null,
    progress: null,
};

enum PublishType {
    CUSTOM = 'custom',
    PREVIEW = 'preview',
    UNPUBLISH = 'unpublish',
}

export class HostingManager {
    state: PublishState = DEFAULT_PUBLISH_STATE;

    constructor() {
        makeAutoObservable(this);
    }

    resetState() {
        this.state = DEFAULT_PUBLISH_STATE
    }

    async publishPreview(projectId: string, { buildScript, urls, options }: PublishRequest): Promise<PublishResponse> {
        return this.publish(PublishType.PREVIEW, projectId, { buildScript, urls, options });
    }

    async publishCustom(projectId: string, { buildScript, urls, options }: PublishRequest): Promise<PublishResponse> {
        return this.publish(PublishType.CUSTOM, projectId, { buildScript, urls, options });
    }

    async unpublish(projectId: string, urls: string[]): Promise<PublishResponse> {
        try {
            const success = await this.deployWeb(PublishType.UNPUBLISH, projectId, {}, urls);

            if (!success) {
                throw new Error('Failed to delete deployment');
            }

            return {
                success: true,
                message: 'Deployment deleted',
            };
        } catch (error) {
            console.error('Failed to delete deployment', error);
            return {
                success: false,
                message: 'Failed to delete deployment. ' + error,
            };
        }
    }

    private async deployWeb(
        type: PublishType,
        projectId: string,
        files: Record<string, FreestyleFile>,
        urls: string[],
        envVars?: Record<string, string>,
    ): Promise<boolean> {
        try {
            const res: DeploymentResponse = await api.domain.preview.publish.mutate({
                projectId,
                files: files,
                type: type === PublishType.CUSTOM ? 'custom' : 'preview',
                config: {
                    domains: urls,
                    entrypoint: 'server.js',
                    envVars,
                },
            });
            return res.success;
        } catch (error) {
            console.error('Failed to deploy project', error);
            return false;
        }
    }
}
