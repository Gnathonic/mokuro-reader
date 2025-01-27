import type { Volume, VolumeFile } from '$lib/types';
import { db } from './db';

/**
 * A compatibility wrapper for the new Volume structure that provides
 * lazy loading of files and maintains backward compatibility
 */
export class VolumeCompat {
  private volume: Volume;
  private loadedFiles: Record<string, File> | null = null;

  constructor(volume: Volume) {
    this.volume = volume;
  }

  get id() {
    return this.volume.id;
  }

  get mokuroData() {
    return this.volume.mokuroData;
  }

  get volumeName() {
    return this.volume.volumeName;
  }

  get thumbnail() {
    return this.volume.thumbnail;
  }

  /**
   * Lazily loads all files associated with this volume
   */
  private async loadFiles(): Promise<Record<string, File>> {
    if (this.loadedFiles) {
      return this.loadedFiles;
    }

    const volumeFiles = await db.volumeFiles
      .where('volumeId')
      .equals(this.volume.id)
      .toArray();

    const files: Record<string, File> = {};
    for (const volumeFile of volumeFiles) {
      files[volumeFile.path] = volumeFile.file;
    }

    this.loadedFiles = files;
    return files;
  }

  /**
   * Provides backward compatibility with the old files property
   */
  async getFiles(): Promise<Record<string, File>> {
    return await this.loadFiles();
  }

  /**
   * Gets a specific file by path
   */
  async getFile(path: string): Promise<File | undefined> {
    const fileId = this.volume.fileIds[path];
    if (!fileId) {
      return undefined;
    }

    // Check if files are already loaded
    if (this.loadedFiles) {
      return this.loadedFiles[path];
    }

    // Load just the requested file
    const volumeFile = await db.volumeFiles.get(fileId);
    return volumeFile?.file;
  }

  /**
   * Updates a file in the volume
   */
  async updateFile(path: string, file: File): Promise<void> {
    const fileId = this.volume.fileIds[path];
    if (!fileId) {
      // Create new file entry
      const newFileId = crypto.randomUUID();
      this.volume.fileIds[path] = newFileId;
      await db.volumeFiles.add({
        id: newFileId,
        volumeId: this.volume.id,
        path,
        file
      });
    } else {
      // Update existing file
      await db.volumeFiles.update(fileId, { file });
    }

    // Update loaded files if they exist
    if (this.loadedFiles) {
      this.loadedFiles[path] = file;
    }
  }

  /**
   * Converts back to a plain Volume object
   */
  toVolume(): Volume {
    return this.volume;
  }

  /**
   * Creates a VolumeCompat instance from a Volume
   */
  static from(volume: Volume): VolumeCompat {
    return new VolumeCompat(volume);
  }
}