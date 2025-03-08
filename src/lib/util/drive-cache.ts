/**
 * Simple virtual Google Drive cache to minimize API calls
 * This stores file metadata in a structure similar to Google Drive
 */

import { DriveErrorType } from './api-helpers';

// Define types for the cache
export type DriveFile = {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  createdTime?: string;
};

export type DriveFileCache = {
  initialized: boolean;
  isStale: boolean;
  filesById: Record<string, DriveFile>;
  filesByParent: Record<string, DriveFile[]>;
  filesByNameAndParent: Record<string, DriveFile>;
};

// Create the cache object
const driveCache: DriveFileCache & {
  addFile: (file: DriveFile) => void;
  removeFile: (fileId: string) => void;
  getFileById: (id: string) => DriveFile | null;
  getFilesByParent: (parentId: string) => DriveFile[];
  getFileByNameAndParent: (name: string, parentId: string) => DriveFile | null;
  markStale: () => void;
  clear: () => void;
  fetchFiles: (options: any) => Promise<DriveFile[]>;
} = {
  // Flag to indicate if the cache is initialized
  initialized: false,
  
  // Flag to indicate if the cache is stale and needs refreshing
  isStale: false,
  
  // Store files by ID for quick lookup
  filesById: {},
  
  // Store files by parent ID for folder navigation
  filesByParent: {},
  
  // Store files by name and parent for quick lookups
  filesByNameAndParent: {},
  
  // Add a file to the cache
  addFile(file) {
    if (!file || !file.id) return;
    
    // Store by ID
    this.filesById[file.id] = file;
    
    // Store by parent
    if (file.parents && file.parents.length > 0) {
      const parentId = file.parents[0];
      if (!this.filesByParent[parentId]) {
        this.filesByParent[parentId] = [];
      }
      
      // Check if file already exists in this parent's array
      const existingIndex = this.filesByParent[parentId].findIndex(f => f.id === file.id);
      if (existingIndex >= 0) {
        // Update existing entry
        this.filesByParent[parentId][existingIndex] = file;
      } else {
        // Add new entry
        this.filesByParent[parentId].push(file);
      }
      
      // Store by name and parent for quick lookups
      const key = `${parentId}:${file.name}`;
      this.filesByNameAndParent[key] = file;
    }
  },
  
  // Remove a file from the cache
  removeFile(fileId) {
    if (!fileId || !this.filesById[fileId]) return;
    
    const file = this.filesById[fileId];
    
    // Remove from filesById
    delete this.filesById[fileId];
    
    // Remove from filesByParent
    if (file.parents && file.parents.length > 0) {
      const parentId = file.parents[0];
      if (this.filesByParent[parentId]) {
        this.filesByParent[parentId] = this.filesByParent[parentId].filter(f => f.id !== fileId);
        
        // Remove from filesByNameAndParent
        const key = `${parentId}:${file.name}`;
        delete this.filesByNameAndParent[key];
      }
    }
  },
  
  // Get a file by ID
  getFileById(id) {
    return this.filesById[id] || null;
  },
  
  // Get files by parent ID
  getFilesByParent(parentId) {
    return this.filesByParent[parentId] || [];
  },
  
  // Get a file by name and parent
  getFileByNameAndParent(name, parentId) {
    const key = `${parentId}:${name}`;
    return this.filesByNameAndParent[key] || null;
  },
  
  // Mark the cache as stale
  markStale() {
    console.log('Marking drive cache as stale');
    this.isStale = true;
  },
  
  // Clear the entire cache
  clear() {
    console.log('Clearing drive cache');
    this.initialized = false;
    this.isStale = false;
    this.filesById = {};
    this.filesByParent = {};
    this.filesByNameAndParent = {};
  },
  
  // Fetch files from Drive API and update the cache
  async fetchFiles({
    parentId = null,
    name = null,
    mimeTypes = [],
    fields = 'files(id, name, mimeType, parents)',
    orderBy = null,
    trashed = false,
    context = 'fetching files'
  } = {}) {
    try {
      // Build the query parts
      const queryParts = [];
      
      // Add parent folder constraint if provided
      if (parentId) {
        queryParts.push(`'${parentId}' in parents`);
      }
      
      // Add name constraint if provided
      if (name) {
        queryParts.push(`name='${name}'`);
      }
      
      // Add mime type constraints if provided
      if (mimeTypes.length > 0) {
        const mimeTypeQuery = mimeTypes.map(type => `mimeType='${type}'`).join(' or ');
        queryParts.push(`(${mimeTypeQuery})`);
      }
      
      // Add trashed constraint
      queryParts.push(`trashed=${trashed}`);
      
      // Combine all query parts with AND
      const query = queryParts.join(' and ');
      
      // Build the request parameters
      const params: any = {
        q: query,
        fields,
        pageSize: 1000
      };
      
      // Add orderBy if provided
      if (orderBy) {
        params.orderBy = orderBy;
      }
      
      console.log(`Making Drive API list call for: ${context}`);
      // Execute the request
      const { result } = await gapi.client.drive.files.list(params);
      const files = result.files || [];
      
      // Add files to cache
      files.forEach(file => this.addFile(file));
      
      // If this was a folder listing, mark that we've cached this folder's contents
      if (parentId && files.length > 0) {
        this.filesByParent[parentId] = files;
      }
      
      return files;
    } catch (error: any) {
      // Check if this is an error that might indicate our cache is out of sync
      if (error.errorType === DriveErrorType.NOT_FOUND || 
          error.status === 404 || 
          (error.message && error.message.toLowerCase().includes('not found'))) {
        this.markStale();
        console.warn('Resource not found, marking cache as stale');
      }
      
      // Re-throw the error to be handled by the caller
      throw error;
    }
  }
};

/**
 * Helper function to lazily get a specific file ID from Drive
 * @param name File name to look for
 * @param parentId Parent folder ID
 * @param forceRefresh Whether to force a cache refresh
 * @returns The file ID if found, null otherwise
 */
export async function getFileId(name: string, parentId: string, forceRefresh = false) {
  if (!parentId) return null;
  
  // Check if we have this file in the cache
  if (!forceRefresh && !driveCache.isStale) {
    const cachedFile = driveCache.getFileByNameAndParent(name, parentId);
    if (cachedFile) {
      return cachedFile.id;
    }
  }
  
  try {
    // If not in cache or cache is stale, fetch from Drive
    const files = await driveCache.fetchFiles({
      parentId,
      name,
      fields: 'files(id, name, parents)',
      context: `getting ID for ${name}`
    });
    
    return files.length > 0 ? files[0].id : null;
  } catch (error) {
    console.error(`Error getting file ID for ${name}:`, error);
    return null;
  }
}

/**
 * Function to list files in a folder using our cache
 * @param parentId The parent folder ID
 * @param options Additional options
 * @returns Array of files in the folder
 */
export async function listFilesInFolder(parentId: string | null, options: any = {}) {
  const { forceRefresh = false, mimeTypes = [], handleError = true, name = null, fields = undefined } = options;
  
  // If parentId is null, we can't use the cache for folder contents
  // But we can still use the fetchFiles method with other filters
  if (parentId) {
    // Check if we have this folder's contents in the cache
    if (!forceRefresh && !driveCache.isStale) {
      const cachedFiles = driveCache.getFilesByParent(parentId);
      if (cachedFiles.length > 0) {
        // Filter by mime types if specified
        if (mimeTypes.length > 0) {
          return cachedFiles.filter(file => mimeTypes.includes(file.mimeType));
        }
        return cachedFiles;
      }
    }
  }
  
  try {
    // If not in cache or cache is stale, fetch from Drive
    return await driveCache.fetchFiles({
      parentId,
      name,
      mimeTypes,
      fields: fields || 'files(id, name, mimeType, parents)',
      context: `listing files in folder ${parentId || 'root'}`,
      ...(options.orderBy ? { orderBy: options.orderBy } : {})
    });
  } catch (error) {
    if (handleError) {
      console.error(`Error listing files in folder ${parentId || 'root'}:`, error);
      return [];
    }
    throw error;
  }
}

export default driveCache;