import { writable } from 'svelte/store';

export interface Process {
  id: string;
  description: string;
  status?: string;
  progress: number;
  bytesLoaded?: number;
  totalBytes?: number;
}

interface ProgressTrackerState {
  processes: Process[];
}

function createProgressTrackerStore() {
  const initialState: ProgressTrackerState = {
    processes: []
  };

  const { subscribe, update } = writable<ProgressTrackerState>(initialState);

  return {
    subscribe,
    addProcess: (process: Process) => {
      update((state) => {
        // Check if process with this ID already exists
        const existingIndex = state.processes.findIndex((p) => p.id === process.id);

        if (existingIndex >= 0) {
          // Update existing process
          const updatedProcesses = [...state.processes];
          updatedProcesses[existingIndex] = process;
          return { ...state, processes: updatedProcesses };
        } else {
          // Add new process
          return { ...state, processes: [...state.processes, process] };
        }
      });
    },
    updateProcess: (id: string, updates: Partial<Omit<Process, 'id'>>) => {
      update((state) => {
        const existingIndex = state.processes.findIndex((p) => p.id === id);

        if (existingIndex >= 0) {
          const updatedProcesses = [...state.processes];
          updatedProcesses[existingIndex] = {
            ...updatedProcesses[existingIndex],
            ...updates
          };
          return { ...state, processes: updatedProcesses };
        }

        return state;
      });
    },
    removeProcess: (id: string) => {
      update((state) => {
        return {
          ...state,
          processes: state.processes.filter((p) => p.id !== id)
        };
      });
    },
    clearAll: () => {
      update(() => initialState);
    }
  };
}

export const progressTrackerStore = createProgressTrackerStore();
