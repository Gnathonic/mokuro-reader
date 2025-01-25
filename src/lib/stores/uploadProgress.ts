import { writable } from 'svelte/store';

export interface VolumeProgress {
  name: string;
  status: 'pending' | 'processing' | 'complete' | 'error';
  progress: number;
  message?: string;
}

export interface UploadProgress {
  volumes: Record<string, VolumeProgress>;
  totalFiles: number;
  processedFiles: number;
  currentPhase: 'preparing' | 'processing' | 'saving' | 'complete' | 'error';
}

const initialState: UploadProgress = {
  volumes: {},
  totalFiles: 0,
  processedFiles: 0,
  currentPhase: 'preparing'
};

export const uploadProgress = writable<UploadProgress>(initialState);

export const resetProgress = () => {
  uploadProgress.set(initialState);
};

export const updateVolumeProgress = (path: string, progress: Partial<VolumeProgress>) => {
  uploadProgress.update(state => {
    const volume = state.volumes[path] || { name: path, status: 'pending', progress: 0 };
    state.volumes[path] = { ...volume, ...progress };
    return state;
  });
};

export const updateProgress = (progress: Partial<UploadProgress>) => {
  uploadProgress.update(state => ({ ...state, ...progress }));
};