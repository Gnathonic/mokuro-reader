import { w as writable } from "./index.js";
const snackbarStore = writable(void 0);
function showSnackbar(message, duration = 3e3) {
  snackbarStore.set({
    visible: true,
    message
  });
  setTimeout(() => {
    snackbarStore.set(void 0);
  }, duration);
}
function createProgressTrackerStore() {
  const initialState = {
    processes: []
  };
  const { subscribe, update } = writable(initialState);
  return {
    subscribe,
    addProcess: (process) => {
      update((state) => {
        const existingIndex = state.processes.findIndex((p) => p.id === process.id);
        if (existingIndex >= 0) {
          const updatedProcesses = [...state.processes];
          updatedProcesses[existingIndex] = process;
          return { ...state, processes: updatedProcesses };
        } else {
          return { ...state, processes: [...state.processes, process] };
        }
      });
    },
    updateProcess: (id, updates) => {
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
    removeProcess: (id) => {
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
const progressTrackerStore = createProgressTrackerStore();
export {
  showSnackbar as a,
  progressTrackerStore as p,
  snackbarStore as s
};
