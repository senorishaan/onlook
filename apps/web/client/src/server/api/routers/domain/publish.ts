import { api } from '@/trpc/client';
import { CUSTOM_OUTPUT_DIR, DefaultSettings, EXCLUDED_PUBLISH_DIRECTORIES, SUPPORTED_LOCK_FILES } from '@onlook/constants';
import { addBuiltWithScript, injectBuiltWithScript, removeBuiltWithScript, removeBuiltWithScriptFromLayout } from '@onlook/growth';
import {
    PublishStatus,
    type DeploymentResponse,
    type PublishOptions,
    type PublishRequest,
    type PublishResponse,
    type PublishState,
} from '@onlook/models';
import { addNextBuildConfig } from '@onlook/parser';
import { isBinaryFile, isEmptyString, isNullOrUndefined, LogTimer, updateGitignore, type FileOperations } from '@onlook/utility';
import {
    type FreestyleFile,
} from 'freestyle-sandboxes';
import { z } from "zod";
import { createTRPCRouter, publicProcedure } from "../../trpc";

enum PublishType {
    CUSTOM = 'custom',
    PREVIEW = 'preview',
    UNPUBLISH = 'unpublish',
}

export const publishRouter = createTRPCRouter({
    publish: publicProcedure.input(z.object({
        projectId: z.string(),
        domain: z.string(),
        type: z.nativeEnum(PublishType),
        buildScript: z.string(),
        urls: z.array(z.string()),
        options: z.object({
            skipBadge: z.boolean(),
            skipBuild: z.boolean(),
            buildFlags: z.string(),
            envVars: z.record(z.string(), z.string()),
        }),
    })).mutation(async ({ ctx, input }) => {
        const { projectId, domain, type, buildScript, urls, options } = input;

        // Fork sandbox 
        // Open a connection
        // Run build process
        const updateState = (state: Partial<PublishState>) => {
            // TODO: update state in db
        }

        const fileOps = {
            readFile: (path: string) => this.editorEngine.sandbox.readFile(path),
            writeFile: (path: string, content: string) => this.editorEngine.sandbox.writeFile(path, content),
            fileExists: (path: string) => this.editorEngine.sandbox.fileExists(path),
            copy: (source: string, destination: string, recursive?: boolean, overwrite?: boolean) => this.editorEngine.sandbox.copy(source, destination, recursive, overwrite),
            delete: (path: string, recursive?: boolean) => this.editorEngine.sandbox.delete(path, recursive),
            readdir: (path: string) => this.editorEngine.sandbox.session.session!.fs.readdir(path),
            readBinaryFile: (path: string) => this.editorEngine.sandbox.session.session!.fs.readBinaryFile(path),
            runCommand: (command: string, callback: (output: string) => void) => this.editorEngine.sandbox.session.runCommand(command, callback),
        } satisfies FileOperations;

        return await publish(projectId, updateState, fileOps, { buildScript, urls, options });

    }),
});

const publish = async (
    projectId: string,
    updateState: (state: Partial<PublishState>) => void,
    fileOps: FileOperations,
    { buildScript, urls, options }: PublishRequest,
): Promise<PublishResponse> => {
    try {
        const timer = new LogTimer('Deployment');

        updateState({ status: PublishStatus.LOADING, message: 'Preparing project...', progress: 5 });
        await runPrepareStep(fileOps);
        timer.log('Prepare completed');

        if (!options?.skipBadge) {
            updateState({ status: PublishStatus.LOADING, message: 'Adding badge...', progress: 10 });
            await addBadge('./', fileOps);
            timer.log('"Built with Onlook" badge added');
        }

        // Run the build script
        if (!options?.skipBuild) {
            updateState({ status: PublishStatus.LOADING, message: 'Creating optimized build...', progress: 20 });
            await runBuildStep(buildScript, options, fileOps);
        } else {
            console.log('Skipping build');
        }
        timer.log('Build completed');
        updateState({ status: PublishStatus.LOADING, message: 'Preparing project for deployment...', progress: 60 });

        // Postprocess the project for deployment
        const { success: postprocessSuccess, error: postprocessError } =
            await postprocessNextBuild(fileOps);
        timer.log('Postprocess completed');

        if (!postprocessSuccess) {
            throw new Error(
                `Failed to postprocess project for deployment, error: ${postprocessError}`,
            );
        }

        // Serialize the files for deployment
        const NEXT_BUILD_OUTPUT_PATH = `${CUSTOM_OUTPUT_DIR}/standalone`;
        const files = await serializeFiles(NEXT_BUILD_OUTPUT_PATH, fileOps);

        updateState({ status: PublishStatus.LOADING, message: 'Deploying project...', progress: 80 });

        timer.log('Files serialized, sending to Freestyle...');
        const success = await deployWeb(PublishType.CUSTOM, projectId, files, urls, options?.envVars);

        if (!success) {
            throw new Error('Failed to deploy project');
        }

        updateState({ status: PublishStatus.PUBLISHED, message: 'Deployment successful. Cleaning up...', progress: 90 });

        if (!options?.skipBadge) {
            updateState({ status: PublishStatus.LOADING, message: 'Cleaning up...', progress: 90 });
            await removeBadge('./', fileOps);
            timer.log('"Built with Onlook" badge removed');
        }

        timer.log('Deployment completed');
        updateState({ status: PublishStatus.PUBLISHED, message: 'Deployment successful!', progress: 100 });

        return {
            success: true,
            message: 'Deployment successful',
        };
    } catch (error) {
        console.error('Failed to deploy to preview environment', error);
        updateState({ status: PublishStatus.ERROR, message: 'Failed to deploy to preview environment', progress: 100 });
        return {
            success: false,
            message: error instanceof Error ? error.message : 'Unknown error',
        };
    }
}

const addBadge = async (folderPath: string, fileOps: FileOperations) => {
    await injectBuiltWithScript(folderPath, fileOps);
    await addBuiltWithScript(folderPath, fileOps);
}

const removeBadge = async (folderPath: string, fileOps: FileOperations) => {
    await removeBuiltWithScriptFromLayout(folderPath, fileOps);
    await removeBuiltWithScript(folderPath, fileOps);
}

const runPrepareStep = async (fileOps: FileOperations) => {
    // Preprocess the project
    const preprocessSuccess = await addNextBuildConfig(fileOps);

    if (!preprocessSuccess) {
        throw new Error(`Failed to prepare project for deployment`);
    }

    // Update .gitignore to ignore the custom output directory
    const gitignoreSuccess = await updateGitignore(CUSTOM_OUTPUT_DIR, fileOps);
    if (!gitignoreSuccess) {
        console.warn('Failed to update .gitignore');
    }
}

const runBuildStep = async (buildScript: string, options?: PublishOptions, fileOps: FileOperations) => {
    // Use default build flags if no build flags are provided
    const buildFlagsString: string = isNullOrUndefined(options?.buildFlags)
        ? DefaultSettings.EDITOR_SETTINGS.buildFlags
        : options?.buildFlags || '';

    const BUILD_SCRIPT_NO_LINT = isEmptyString(buildFlagsString)
        ? buildScript
        : `${buildScript} -- ${buildFlagsString}`;

    if (options?.skipBuild) {
        console.log('Skipping build');
        return;
    }

    const {
        success: buildSuccess,
        error: buildError,
        output: buildOutput,
    } = await fileOps.runCommand(BUILD_SCRIPT_NO_LINT, (output: string) => {
        console.log('Build output: ', output);
    });

    if (!buildSuccess) {
        throw new Error(`Build failed with error: ${buildError}`);
    } else {
        console.log('Build succeeded with output: ', buildOutput);
    }
}

const postprocessNextBuild = async (fileOps: FileOperations): Promise<{
    success: boolean;
    error?: string;
}> => {
    const entrypointExists = await fileOps.fileExists(
        `${CUSTOM_OUTPUT_DIR}/standalone/server.js`,
    );
    if (!entrypointExists) {
        return {
            success: false,
            error: `Failed to find entrypoint server.js in ${CUSTOM_OUTPUT_DIR}/standalone`,
        };
    }

    await fileOps.copy(`public`, `${CUSTOM_OUTPUT_DIR}/standalone/public`, true, true);
    await fileOps.copy(
        `${CUSTOM_OUTPUT_DIR}/static`,
        `${CUSTOM_OUTPUT_DIR}/standalone/${CUSTOM_OUTPUT_DIR}/static`,
        true,
        true,
    );

    for (const lockFile of SUPPORTED_LOCK_FILES) {
        const lockFileExists = await fileOps.fileExists(`./${lockFile}`);
        if (lockFileExists) {
            await fileOps.copy(
                `./${lockFile}`,
                `${CUSTOM_OUTPUT_DIR}/standalone/${lockFile}`,
                true,
                true,
            );
            return { success: true };
        } else {
            console.error(`lockFile not found: ${lockFile}`);
        }
    }

    return {
        success: false,
        error:
            'Failed to find lock file. Supported lock files: ' +
            SUPPORTED_LOCK_FILES.join(', '),
    };
}

/**
 * Serializes all files in a directory for deployment using parallel processing
 * @param currentDir - The directory path to serialize
 * @returns Record of file paths to their content (base64 for binary, utf-8 for text)
 */
const serializeFiles = async (currentDir: string, fileOps: FileOperations): Promise<Record<string, FreestyleFile>> => {
    const timer = new LogTimer('File Serialization');

    try {
        const allFilePaths = await getAllFilePathsFlat(currentDir, fileOps);
        timer.log(`File discovery completed - ${allFilePaths.length} files found`);

        const filteredPaths = allFilePaths.filter(filePath => !shouldSkipFile(filePath));

        const { binaryFiles, textFiles } = categorizeFiles(filteredPaths);

        const BATCH_SIZE = 50;
        const files: Record<string, FreestyleFile> = {};

        if (textFiles.length > 0) {
            timer.log(`Processing ${textFiles.length} text files in batches of ${BATCH_SIZE}`);
            for (let i = 0; i < textFiles.length; i += BATCH_SIZE) {
                const batch = textFiles.slice(i, i + BATCH_SIZE);
                const batchFiles = await processTextFilesBatch(batch, currentDir, fileOps);
                Object.assign(files, batchFiles);
            }
            timer.log('Text files processing completed');
        }

        if (binaryFiles.length > 0) {
            timer.log(`Processing ${binaryFiles.length} binary files in batches of ${BATCH_SIZE}`);
            for (let i = 0; i < binaryFiles.length; i += BATCH_SIZE) {
                const batch = binaryFiles.slice(i, i + BATCH_SIZE);
                const batchFiles = await processBinaryFilesBatch(batch, currentDir, fileOps);
                Object.assign(files, batchFiles);
            }
            timer.log('Binary files processing completed');
        }

        timer.log(`Serialization completed - ${Object.keys(files).length} files processed`);
        return files;
    } catch (error) {
        console.error(`[serializeFiles] Error during serialization:`, error);
        throw error;
    }
}

const deployWeb = async (
    type: PublishType,
    projectId: string,
    files: Record<string, FreestyleFile>,
    urls: string[],
    envVars?: Record<string, string>,
): Promise<boolean> => {
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

const getAllFilePathsFlat = async (rootDir: string, fileOps: FileOperations): Promise<string[]> => {
    const allPaths: string[] = [];
    const dirsToProcess = [rootDir];

    while (dirsToProcess.length > 0) {
        const currentDir = dirsToProcess.shift()!;
        try {
            const entries = await fileOps.readdir(currentDir);

            for (const entry of entries) {
                const fullPath = `${currentDir}/${entry.name}`;

                if (entry.type === 'directory') {
                    // Skip node_modules and other heavy directories early
                    if (!EXCLUDED_PUBLISH_DIRECTORIES.includes(entry.name)) {
                        dirsToProcess.push(fullPath);
                    }
                } else if (entry.type === 'file') {
                    allPaths.push(fullPath);
                }
            }
        } catch (error) {
            console.warn(`[getAllFilePathsFlat] Error reading directory ${currentDir}:`, error);
        }
    }

    return allPaths;
}
/**
 * Check if a file should be skipped
 */
const shouldSkipFile = (filePath: string): boolean => {
    return filePath.includes('node_modules') ||
        filePath.includes('.git/') ||
        filePath.includes('/.next/') ||
        filePath.includes('/dist/') ||
        filePath.includes('/build/') ||
        filePath.includes('/coverage/');
}

const categorizeFiles = (filePaths: string[]): { binaryFiles: string[], textFiles: string[] } => {
    const binaryFiles: string[] = [];
    const textFiles: string[] = [];

    for (const filePath of filePaths) {
        const fileName = filePath.split('/').pop() || '';
        if (isBinaryFile(fileName)) {
            binaryFiles.push(filePath);
        } else {
            textFiles.push(filePath);
        }
    }

    return { binaryFiles, textFiles };
}

const processTextFilesBatch = async (filePaths: string[], baseDir: string, fileOps: FileOperations): Promise<Record<string, FreestyleFile>> => {
    const promises = filePaths.map(async (fullPath) => {
        const relativePath = fullPath.replace(baseDir + '/', '');

        try {
            const textContent = await fileOps.readFile(fullPath);

            if (textContent !== null) {
                return {
                    path: relativePath,
                    file: {
                        content: textContent,
                        encoding: 'utf-8' as const,
                    }
                };
            } else {
                console.warn(`[processTextFilesBatch] Failed to read text content for ${relativePath}`);
                return null;
            }
        } catch (error) {
            console.warn(`[processTextFilesBatch] Error processing ${relativePath}:`, error);
            return null;
        }
    });

    const results = await Promise.all(promises);
    const files: Record<string, FreestyleFile> = {};

    for (const result of results) {
        if (result) {
            files[result.path] = result.file;
        }
    }

    return files;
}

const processBinaryFilesBatch = async (filePaths: string[], baseDir: string, fileOps: FileOperations): Promise<Record<string, FreestyleFile>> => {
    const promises = filePaths.map(async (fullPath) => {
        const relativePath = fullPath.replace(baseDir + '/', '');

        try {
            const binaryContent = await fileOps.readBinaryFile(fullPath);

            if (binaryContent) {
                const base64String = btoa(
                    Array.from(binaryContent)
                        .map((byte: number) => String.fromCharCode(byte))
                        .join(''),
                );

                return {
                    path: relativePath,
                    file: {
                        content: base64String,
                        encoding: 'base64' as const,
                    }
                };
            } else {
                console.warn(`[processBinaryFilesBatch] Failed to read binary content for ${relativePath}`);
                return null;
            }
        } catch (error) {
            console.warn(`[processBinaryFilesBatch] Error processing ${relativePath}:`, error);
            return null;
        }
    });

    const results = await Promise.all(promises);
    const files: Record<string, FreestyleFile> = {};

    for (const result of results) {
        if (result) {
            files[result.path] = result.file;
        }
    }

    return files;
}