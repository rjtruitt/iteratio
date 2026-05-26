/**
 * Available storage backend types.
 */
export type StorageBackend = 'memory' | 'filesystem' | 's3' | 'redis';

/**
 * Metadata describing a stored artifact including identity, permissions,
 * storage location, and content metadata.
 */
export interface ArtifactInfo {
  /** Unique artifact ID. */
  id: string;

  /** Original filename. */
  name: string;

  /** MIME type. */
  type: string;

  /** Size in bytes. */
  size: number;

  /** Instance ID that created this artifact. */
  createdBy: string;

  /** Creation timestamp. */
  createdAt: number;

  /** Instance IDs permitted to access this artifact. */
  accessibleBy: string[];

  /** Storage location details. */
  storage: {
    type: StorageBackend;
    path?: string;
    url?: string;
    key?: string;
    /** Auto-delete after this many seconds. */
    ttl?: number;
  };

  /** Content and provenance metadata. */
  metadata?: {
    originalPath?: string;
    sourceMachine?: string;
    contentHash?: string;
    tags?: string[];
    [key: string]: any;
  };
}

/**
 * Request parameters for uploading an artifact.
 */
export interface UploadRequest {
  /** Buffer containing file data. File path upload is not yet supported. */
  source: string | Buffer;

  /** Filename (defaults to 'artifact' if not provided). */
  name?: string;

  /** MIME type (auto-detected from filename if not provided). */
  type?: string;

  /** Instance IDs that can access this artifact (defaults to creator only). */
  accessibleBy?: string[];

  /** TTL in seconds (defaults to config.defaultTTL). */
  ttl?: number;

  /** Additional metadata to attach. */
  metadata?: Record<string, any>;
}

/**
 * Result of a successful upload operation.
 */
export interface UploadResult {
  /** Unique artifact ID for retrieval. */
  artifactId: string;

  /** Artifact retrieval URL. */
  url: string;

  /** Size in bytes. */
  size: number;

  /** SHA-256 content hash for integrity verification. */
  hash: string;
}

/**
 * Request parameters for downloading an artifact.
 */
export interface DownloadRequest {
  /** Artifact ID to download. */
  artifactId: string;

  /** Instance ID of the requester (for permission checks). */
  requesterId: string;

  /** Destination file path (returns Buffer if not provided). */
  destination?: string;
}

/**
 * Configuration for the artifact transfer system.
 */
export interface ArtifactTransferConfig {
  /** Storage backend type. */
  backend: StorageBackend;

  /** Backend-specific storage options. */
  storage?: {
    path?: string;
    bucket?: string;
    region?: string;
    redisUrl?: string;
  };

  /** Default TTL for artifacts in seconds (default: 3600). */
  defaultTTL?: number;

  /** Maximum artifact size in bytes (default: 100MB). */
  maxSize?: number;

  /** Interval between cleanup runs in milliseconds (default: 60000). */
  cleanupInterval?: number;

  /** Instance ID of this node. */
  instanceId: string;
}
