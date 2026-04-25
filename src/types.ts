export interface AzureDevOpsConfig {
    organization: string;
    project: string;
}

export interface Repository {
    id: string;
    name: string;
    project: { id: string; name: string };
}

export interface PullRequest {
    pullRequestId: number;
    title: string;
    description: string;
    status: string;
    createdBy: {
        displayName: string;
        uniqueName: string;
        imageUrl?: string;
    };
    creationDate: string;
    sourceRefName: string;
    targetRefName: string;
    repository: Repository;
    lastMergeSourceCommit?: { commitId: string };
    lastMergeTargetCommit?: { commitId: string };
}

export interface ChangeEntry {
    changeId: number;
    item: {
        path: string;
        objectId?: string;
        originalObjectId?: string;
    };
    changeType: number;
}

export interface Iteration {
    id: number;
    description: string;
    sourceRefCommit: { commitId: string };
    targetRefCommit: { commitId: string };
}

export interface DiffContext {
    prId: number;
    prTitle: string;
    filePath: string;
    changeType: string;
    repoId: string;
    sourceCommitId: string;
    targetCommitId: string;
}

export interface CommentThread {
    id: number;
    status: number;
    threadContext?: {
        filePath: string;
        rightFileStart?: { line: number; offset: number };
        rightFileEnd?: { line: number; offset: number };
        leftFileStart?: { line: number; offset: number };
        leftFileEnd?: { line: number; offset: number };
    };
    comments: Comment[];
    isDeleted: boolean;
}

export interface Comment {
    id: number;
    content: string;
    author: {
        displayName: string;
        uniqueName: string;
    };
    publishedDate: string;
    lastUpdatedDate: string;
    commentType: number;
    isDeleted: boolean;
}
