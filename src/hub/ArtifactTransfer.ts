import { EventEmitter } from 'events';
import * as crypto from 'crypto';
import type { ArtifactInfo, UploadRequest, UploadResult, DownloadRequest, ArtifactTransferConfig } from './ArtifactTransferTypes.js';

export type { StorageBackend, ArtifactInfo, UploadRequest, UploadResult, DownloadRequest, ArtifactTransferConfig } from './ArtifactTransferTypes.js';

/** Manages artifact uploads, downloads, streaming, and lifecycle across instances. */
export class ArtifactTransfer extends EventEmitter {
  private config: Required<ArtifactTransferConfig>;
  private artifacts: Map<string, ArtifactInfo> = new Map();
  private cleanupTimer: NodeJS.Timeout | null = null;
  private memoryStorage: Map<string, Buffer> = new Map();

  /**
   * Create a new ArtifactTransfer instance.
   *
   * @param config - Configuration including storage backend, TTLs, size limits, and instance ID
   */
  constructor(config: ArtifactTransferConfig) {
    super();

    this.config = {
      backend: config.backend,
      storage: config.storage ?? {},
      defaultTTL: config.defaultTTL ?? 3600,
      maxSize: config.maxSize ?? 100 * 1024 * 1024,
      cleanupInterval: config.cleanupInterval ?? 60000,
      instanceId: config.instanceId,
    };

    this.startCleanup();
  }

  /**
   * Upload an artifact to the configured storage backend.
   *
   * @param request - Upload parameters including source data and metadata
   * @returns Upload result with artifact ID, URL, size, and content hash
   * @throws Error if source is a file path (not yet implemented) or exceeds maxSize
   */
  async uploadArtifact(request: UploadRequest): Promise<UploadResult> {
    console.log(`[ArtifactTransfer] Uploading artifact: ${request.name}`);

    const artifactId = this.generateArtifactId();

    let data: Buffer;
    let name: string;
    let size: number;

    if (request.name !== undefined && request.name.length === 0) {
      throw new Error('Artifact name cannot be empty');
    }

    if (Buffer.isBuffer(request.source)) {
      data = request.source;
      name = request.name ?? 'artifact';
      size = data.length;
    } else {
      throw new Error('File path upload not yet implemented');
    }

    if (size > this.config.maxSize) {
      throw new Error(`Artifact size ${size} exceeds max size ${this.config.maxSize}`);
    }

    const hash = crypto.createHash('sha256').update(data).digest('hex');
    const type = request.type ?? this.detectMimeType(name);

    const artifactInfo: ArtifactInfo = {
      id: artifactId,
      name,
      type,
      size,
      createdBy: this.config.instanceId,
      createdAt: Date.now(),
      accessibleBy: request.accessibleBy ?? [this.config.instanceId],
      storage: {
        type: this.config.backend,
        ttl: request.ttl ?? this.config.defaultTTL,
      },
      metadata: {
        ...request.metadata,
        contentHash: hash,
      },
    };

    switch (this.config.backend) {
      case 'memory':
        await this.uploadToMemory(artifactId, data, artifactInfo);
        break;
      case 'filesystem':
        await this.uploadToFilesystem(artifactId, data, artifactInfo);
        break;
      case 's3':
        await this.uploadToS3(artifactId, data, artifactInfo);
        break;
      case 'redis':
        await this.uploadToRedis(artifactId, data, artifactInfo);
        break;
      default:
        throw new Error(`Unsupported storage backend: ${this.config.backend}`);
    }

    this.artifacts.set(artifactId, artifactInfo);
    this.emit('artifact-uploaded', artifactId, artifactInfo);

    return {
      artifactId,
      url: this.getArtifactUrl(artifactId),
      size,
      hash,
    };
  }

  /**
   * Download an artifact from storage after permission verification.
   *
   * @param request - Download parameters including artifact ID and requester identity
   * @returns Buffer containing the artifact data
   * @throws Error if artifact not found, permission denied, or integrity check fails
   */
  async downloadArtifact(request: DownloadRequest): Promise<Buffer> {
    console.log(`[ArtifactTransfer] Downloading artifact: ${request.artifactId}`);

    const artifactInfo = this.artifacts.get(request.artifactId);
    if (!artifactInfo) {
      throw new Error(`Artifact not found: ${request.artifactId}`);
    }

    if (!this.checkAccess(artifactInfo, request.requesterId)) {
      throw new Error(`Permission denied for artifact: ${request.artifactId}`);
    }

    let data: Buffer;

    switch (artifactInfo.storage.type) {
      case 'memory':
        data = await this.downloadFromMemory(request.artifactId);
        break;
      case 'filesystem':
        data = await this.downloadFromFilesystem(request.artifactId, artifactInfo);
        break;
      case 's3':
        data = await this.downloadFromS3(request.artifactId, artifactInfo);
        break;
      case 'redis':
        data = await this.downloadFromRedis(request.artifactId);
        break;
      default:
        throw new Error(`Unsupported storage backend: ${artifactInfo.storage.type}`);
    }

    const hash = crypto.createHash('sha256').update(data).digest('hex');
    if (artifactInfo.metadata?.contentHash && hash !== artifactInfo.metadata.contentHash) {
      throw new Error(`Integrity check failed for artifact: ${request.artifactId}`);
    }

    if (request.destination) {
      throw new Error('Download to file not yet implemented');
    }

    this.emit('artifact-downloaded', request.artifactId, request.requesterId);

    return data;
  }

  /**
   * Stream an artifact in chunks via an async iterator.
   *
   * @param artifactId - Artifact ID to stream
   * @param options - Stream options including requester ID and chunk size
   * @returns Async iterator yielding Buffer chunks
   * @throws Error if artifact not found or permission denied
   */
  async streamArtifact(
    artifactId: string,
    options: { requesterId: string; chunkSize?: number }
  ): Promise<AsyncIterableIterator<Buffer>> {
    console.log(`[ArtifactTransfer] Streaming artifact: ${artifactId}`);

    const { requesterId, chunkSize = 64 * 1024 } = options;

    const artifactInfo = this.artifacts.get(artifactId);
    if (!artifactInfo) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    if (!this.checkAccess(artifactInfo, requesterId)) {
      throw new Error(`Permission denied for artifact: ${artifactId}`);
    }

    const data = await this.downloadArtifact({ artifactId, requesterId });

    async function* generateChunks(): AsyncIterableIterator<Buffer> {
      for (let offset = 0; offset < data.length; offset += chunkSize) {
        yield data.subarray(offset, Math.min(offset + chunkSize, data.length));
      }
    }

    return generateChunks();
  }

  /**
   * Grant access to an artifact for additional instances.
   *
   * @param artifactId - Artifact to share
   * @param instanceIds - Instance IDs to grant access to
   * @throws Error if artifact not found
   */
  async shareArtifact(artifactId: string, instanceIds: string[]): Promise<void> {
    console.log(`[ArtifactTransfer] Sharing artifact ${artifactId} with ${instanceIds.length} instances`);

    const artifactInfo = this.artifacts.get(artifactId);
    if (!artifactInfo) {
      throw new Error(`Artifact not found: ${artifactId}`);
    }

    for (const instanceId of instanceIds) {
      if (!artifactInfo.accessibleBy.includes(instanceId)) {
        artifactInfo.accessibleBy.push(instanceId);
      }
    }
  }

  /**
   * Delete an artifact from storage and the registry.
   *
   * @param artifactId - Artifact to delete
   */
  async deleteArtifact(artifactId: string): Promise<void> {
    console.log(`[ArtifactTransfer] Deleting artifact: ${artifactId}`);

    const artifactInfo = this.artifacts.get(artifactId);
    if (!artifactInfo) {
      return;
    }

    switch (artifactInfo.storage.type) {
      case 'memory':
        this.memoryStorage.delete(artifactId);
        break;
      case 'filesystem':
        break;
      case 's3':
        break;
      case 'redis':
        break;
    }

    this.artifacts.delete(artifactId);
    this.emit('artifact-deleted', artifactId, 'manual');
  }

  /**
   * Get artifact metadata by ID.
   *
   * @param artifactId - Artifact to look up
   * @returns ArtifactInfo or null if not found
   */
  getArtifact(artifactId: string): ArtifactInfo | null {
    return this.artifacts.get(artifactId) ?? null;
  }

  /**
   * List artifacts matching optional filter criteria.
   *
   * @param filter - Optional filter by creator or accessible instances
   * @returns Array of matching ArtifactInfo
   */
  listArtifacts(filter?: {
    createdBy?: string;
    accessibleBy?: string;
  }): ArtifactInfo[] {
    const artifacts = Array.from(this.artifacts.values());

    if (!filter) {
      return artifacts;
    }

    return artifacts.filter(artifact => {
      if (filter.createdBy && artifact.createdBy !== filter.createdBy) {
        return false;
      }

      if (filter.accessibleBy && !artifact.accessibleBy.includes(filter.accessibleBy)) {
        return false;
      }

      return true;
    });
  }

  /**
   * Stop the cleanup timer and release resources.
   */
  stop(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer);
      this.cleanupTimer = null;
    }
  }

  /**
   * Start the periodic cleanup interval for expired artifacts.
   */
  private startCleanup(): void {
    this.cleanupTimer = setInterval(() => {
      this.cleanupExpiredArtifacts();
    }, this.config.cleanupInterval);
  }

  /**
   * Remove artifacts that have exceeded their TTL.
   */
  private async cleanupExpiredArtifacts(): Promise<void> {
    const now = Date.now();

    for (const [artifactId, info] of this.artifacts.entries()) {
      if (!info.storage.ttl) {
        continue;
      }

      const expiresAt = info.createdAt + (info.storage.ttl * 1000);

      if (now >= expiresAt) {
        console.log(`[ArtifactTransfer] Artifact expired: ${artifactId}`);
        await this.deleteArtifact(artifactId);
        this.emit('artifact-expired', artifactId);
      }
    }
  }

  /**
   * Upload artifact data to the in-memory storage backend.
   *
   * @param artifactId - Artifact ID
   * @param data - Binary data to store
   * @param _info - Artifact metadata (unused)
   */
  private async uploadToMemory(artifactId: string, data: Buffer, _info: ArtifactInfo): Promise<void> {
    this.emit('upload-progress', artifactId, 0);
    this.memoryStorage.set(artifactId, data);
    this.emit('upload-progress', artifactId, 100);
  }

  /**
   * Download artifact data from the in-memory storage backend.
   *
   * @param artifactId - Artifact ID to retrieve
   * @returns Buffer containing the artifact data
   */
  private async downloadFromMemory(artifactId: string): Promise<Buffer> {
    this.emit('download-progress', artifactId, 0);
    const data = this.memoryStorage.get(artifactId);
    if (!data) {
      throw new Error(`Artifact not found in memory: ${artifactId}`);
    }
    this.emit('download-progress', artifactId, 100);
    return data;
  }

  /**
   * Upload artifact data to the filesystem backend.
   * @throws Error - Not yet implemented
   */
  private async uploadToFilesystem(_artifactId: string, _data: Buffer, _info: ArtifactInfo): Promise<void> {
    throw new Error('Filesystem storage not yet implemented');
  }

  /**
   * Download artifact data from the filesystem backend.
   * @throws Error - Not yet implemented
   */
  private async downloadFromFilesystem(_artifactId: string, _info: ArtifactInfo): Promise<Buffer> {
    throw new Error('Filesystem storage not yet implemented');
  }

  /**
   * Upload artifact data to the S3 backend.
   * @throws Error - Not yet implemented
   */
  private async uploadToS3(_artifactId: string, _data: Buffer, _info: ArtifactInfo): Promise<void> {
    throw new Error('S3 storage not yet implemented');
  }

  /**
   * Download artifact data from the S3 backend.
   * @throws Error - Not yet implemented
   */
  private async downloadFromS3(_artifactId: string, _info: ArtifactInfo): Promise<Buffer> {
    throw new Error('S3 storage not yet implemented');
  }

  /**
   * Upload artifact data to the Redis backend.
   * @throws Error - Not yet implemented
   */
  private async uploadToRedis(_artifactId: string, _data: Buffer, _info: ArtifactInfo): Promise<void> {
    throw new Error('Redis storage not yet implemented');
  }

  /**
   * Download artifact data from the Redis backend.
   * @throws Error - Not yet implemented
   */
  private async downloadFromRedis(_artifactId: string): Promise<Buffer> {
    throw new Error('Redis storage not yet implemented');
  }

  /**
   * Check whether a requester has access permission for an artifact.
   *
   * @param artifactInfo - The artifact's metadata
   * @param requesterId - Instance ID requesting access
   * @returns true if the requester is in the accessibleBy list
   */
  private checkAccess(artifactInfo: ArtifactInfo, requesterId: string): boolean {
    return artifactInfo.accessibleBy.includes(requesterId);
  }

  /**
   * Generate a unique artifact ID.
   *
   * @returns A UUID string
   */
  private generateArtifactId(): string {
    return crypto.randomUUID();
  }

  /**
   * Generate a retrieval URL for an artifact.
   *
   * @param artifactId - The artifact ID
   * @returns A URI in the format artifact://{artifactId}
   */
  private getArtifactUrl(artifactId: string): string {
    return `artifact://${artifactId}`;
  }

  /**
   * Detect the MIME type from a filename extension.
   *
   * @param filename - The original filename
   * @returns The detected MIME type string
   */
  private detectMimeType(filename: string): string {
    const ext = filename.split('.').pop()?.toLowerCase();

    const mimeTypes: Record<string, string> = {
      'txt': 'text/plain',
      'json': 'application/json',
      'png': 'image/png',
      'jpg': 'image/jpeg',
      'jpeg': 'image/jpeg',
      'gif': 'image/gif',
      'pdf': 'application/pdf',
      'mp4': 'video/mp4',
      'mp3': 'audio/mpeg',
    };

    return mimeTypes[ext ?? ''] ?? 'application/octet-stream';
  }
}
