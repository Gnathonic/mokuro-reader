import { c as create_ssr_component, a as compute_rest_props, o as getContext, d as spread, f as escape_attribute_value, e as escape_object } from "./ssr.js";
import { twMerge } from "tailwind-merge";
import { d as derived, r as readable, w as writable } from "./index.js";
import "panzoom";
import { p as page } from "./stores.js";
import { d as db } from "./db.js";
import { liveQuery } from "dexie";
const void_element_names = /^(?:area|base|br|col|command|embed|hr|img|input|keygen|link|meta|param|source|track|wbr)$/;
function is_void(name) {
  return void_element_names.test(name) || name.toLowerCase() === "!doctype";
}
const Button = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $$restProps = compute_rest_props($$props, ["pill", "outline", "size", "href", "type", "color", "shadow"]);
  const group = getContext("group");
  let { pill = false } = $$props;
  let { outline = false } = $$props;
  let { size = group ? "sm" : "md" } = $$props;
  let { href = void 0 } = $$props;
  let { type = "button" } = $$props;
  let { color = group ? outline ? "dark" : "alternative" : "primary" } = $$props;
  let { shadow = false } = $$props;
  const colorClasses = {
    alternative: "text-gray-900 bg-white border border-gray-200 hover:bg-gray-100 dark:bg-gray-800 dark:text-gray-400 hover:text-primary-700 focus:text-primary-700 dark:focus:text-white dark:hover:text-white",
    blue: "text-white bg-blue-700 hover:bg-blue-800 dark:bg-blue-600 dark:hover:bg-blue-700",
    dark: "text-white bg-gray-800 hover:bg-gray-900 dark:bg-gray-800 dark:hover:bg-gray-700",
    green: "text-white bg-green-700 hover:bg-green-800 dark:bg-green-600 dark:hover:bg-green-700",
    light: "text-gray-900 bg-white border border-gray-300 hover:bg-gray-100 dark:bg-gray-800 dark:text-white dark:border-gray-600 dark:hover:bg-gray-700 dark:hover:border-gray-600",
    primary: "text-white bg-primary-700 hover:bg-primary-800 dark:bg-primary-600 dark:hover:bg-primary-700",
    purple: "text-white bg-purple-700 hover:bg-purple-800 dark:bg-purple-600 dark:hover:bg-purple-700",
    red: "text-white bg-red-700 hover:bg-red-800 dark:bg-red-600 dark:hover:bg-red-700",
    yellow: "text-white bg-yellow-400 hover:bg-yellow-500 ",
    none: ""
  };
  const coloredFocusClasses = {
    alternative: "focus:ring-gray-200 dark:focus:ring-gray-700",
    blue: "focus:ring-blue-300 dark:focus:ring-blue-800",
    dark: "focus:ring-gray-300 dark:focus:ring-gray-700",
    green: "focus:ring-green-300 dark:focus:ring-green-800",
    light: "focus:ring-gray-200 dark:focus:ring-gray-700",
    primary: "focus:ring-primary-300 dark:focus:ring-primary-800",
    purple: "focus:ring-purple-300 dark:focus:ring-purple-900",
    red: "focus:ring-red-300 dark:focus:ring-red-900",
    yellow: "focus:ring-yellow-300 dark:focus:ring-yellow-900",
    none: ""
  };
  const coloredShadowClasses = {
    alternative: "shadow-gray-500/50 dark:shadow-gray-800/80",
    blue: "shadow-blue-500/50 dark:shadow-blue-800/80",
    dark: "shadow-gray-500/50 dark:shadow-gray-800/80",
    green: "shadow-green-500/50 dark:shadow-green-800/80",
    light: "shadow-gray-500/50 dark:shadow-gray-800/80",
    primary: "shadow-primary-500/50 dark:shadow-primary-800/80",
    purple: "shadow-purple-500/50 dark:shadow-purple-800/80",
    red: "shadow-red-500/50 dark:shadow-red-800/80 ",
    yellow: "shadow-yellow-500/50 dark:shadow-yellow-800/80 ",
    none: ""
  };
  const outlineClasses = {
    alternative: "text-gray-900 hover:text-white border border-gray-800 hover:bg-gray-900 focus:bg-gray-900 focus:text-white focus:ring-gray-300 dark:border-gray-600 dark:hover:text-white dark:hover:bg-gray-600 dark:focus:ring-gray-800",
    blue: "text-blue-700 hover:text-white border border-blue-700 hover:bg-blue-800 dark:border-blue-500 dark:text-blue-500 dark:hover:text-white dark:hover:bg-blue-600",
    dark: "text-gray-900 hover:text-white border border-gray-800 hover:bg-gray-900 focus:bg-gray-900 focus:text-white dark:border-gray-600 dark:hover:text-white dark:hover:bg-gray-600",
    green: "text-green-700 hover:text-white border border-green-700 hover:bg-green-800 dark:border-green-500 dark:text-green-500 dark:hover:text-white dark:hover:bg-green-600",
    light: "text-gray-500 hover:text-gray-900 bg-white border border-gray-200 dark:border-gray-600 dark:hover:text-white dark:text-gray-400 hover:bg-gray-50 dark:bg-gray-700 dark:hover:bg-gray-600",
    primary: "text-primary-700 hover:text-white border border-primary-700 hover:bg-primary-700 dark:border-primary-500 dark:text-primary-500 dark:hover:text-white dark:hover:bg-primary-600",
    purple: "text-purple-700 hover:text-white border border-purple-700 hover:bg-purple-800 dark:border-purple-400 dark:text-purple-400 dark:hover:text-white dark:hover:bg-purple-500",
    red: "text-red-700 hover:text-white border border-red-700 hover:bg-red-800 dark:border-red-500 dark:text-red-500 dark:hover:text-white dark:hover:bg-red-600",
    yellow: "text-yellow-400 hover:text-white border border-yellow-400 hover:bg-yellow-500 dark:border-yellow-300 dark:text-yellow-300 dark:hover:text-white dark:hover:bg-yellow-400",
    none: ""
  };
  const sizeClasses = {
    xs: "px-3 py-2 text-xs",
    sm: "px-4 py-2 text-sm",
    md: "px-5 py-2.5 text-sm",
    lg: "px-5 py-3 text-base",
    xl: "px-6 py-3.5 text-base"
  };
  const hasBorder = () => outline || color === "alternative" || color === "light";
  let buttonClass;
  if ($$props.pill === void 0 && $$bindings.pill && pill !== void 0)
    $$bindings.pill(pill);
  if ($$props.outline === void 0 && $$bindings.outline && outline !== void 0)
    $$bindings.outline(outline);
  if ($$props.size === void 0 && $$bindings.size && size !== void 0)
    $$bindings.size(size);
  if ($$props.href === void 0 && $$bindings.href && href !== void 0)
    $$bindings.href(href);
  if ($$props.type === void 0 && $$bindings.type && type !== void 0)
    $$bindings.type(type);
  if ($$props.color === void 0 && $$bindings.color && color !== void 0)
    $$bindings.color(color);
  if ($$props.shadow === void 0 && $$bindings.shadow && shadow !== void 0)
    $$bindings.shadow(shadow);
  buttonClass = twMerge(
    "text-center font-medium",
    group ? "focus:ring-2" : "focus:ring-4",
    group && "focus:z-10",
    group || "focus:outline-none",
    "inline-flex items-center justify-center " + sizeClasses[size],
    outline ? outlineClasses[color] : colorClasses[color],
    color === "alternative" && (group ? "dark:bg-gray-700 dark:text-white dark:border-gray-700 dark:hover:border-gray-600 dark:hover:bg-gray-600" : "dark:bg-transparent dark:border-gray-600 dark:hover:border-gray-700"),
    outline && color === "dark" && (group ? "dark:text-white dark:border-white" : "dark:text-gray-400 dark:border-gray-700"),
    coloredFocusClasses[color],
    hasBorder() && group && "border-l-0 first:border-l",
    group ? pill && "first:rounded-l-full last:rounded-r-full" || "first:rounded-l-lg last:rounded-r-lg" : pill && "rounded-full" || "rounded-lg",
    shadow && "shadow-lg",
    shadow && coloredShadowClasses[color],
    $$props.disabled && "cursor-not-allowed opacity-50",
    $$props.class
  );
  return `${((tag) => {
    return tag ? `<${href ? "a" : "button"}${spread(
      [
        {
          type: escape_attribute_value(href ? void 0 : type)
        },
        { href: escape_attribute_value(href) },
        {
          role: escape_attribute_value(href ? "link" : "button")
        },
        escape_object($$restProps),
        {
          class: escape_attribute_value(buttonClass)
        }
      ],
      {}
    )}>${is_void(tag) ? "" : `${slots.default ? slots.default({}) : ``}`}${is_void(tag) ? "" : `</${tag}>`}` : "";
  })(href ? "a" : "button")} `;
});
function sortTitles(a, b) {
  return a.title.localeCompare(b.title, void 0, { sensitivity: "base" });
}
function deriveSeriesFromVolumes(volumeEntries) {
  const titleMap = /* @__PURE__ */ new Map();
  for (const entry of volumeEntries) {
    let volumes2 = titleMap.get(entry.series_uuid);
    if (volumes2 === void 0) {
      volumes2 = {
        title: entry.series_title,
        series_uuid: entry.series_uuid,
        volumes: []
      };
      titleMap.set(entry.series_uuid, volumes2);
    }
    volumes2.volumes.push(entry);
  }
  const titles = Array.from(titleMap.values());
  for (const title of titles) {
    title.volumes;
  }
  titles.sort(sortTitles);
  return titles;
}
function sortVolumes(a, b) {
  if (a.volume_title < b.volume_title) {
    return -1;
  }
  if (a.volume_title > b.volume_title) {
    return 1;
  }
  return 0;
}
const volumes$1 = readable({}, (set) => {
  const subscription = liveQuery(async () => {
    const volumesArray = await db.volumes.toArray();
    return volumesArray.reduce((acc, vol) => {
      acc[vol.volume_uuid] = vol;
      return acc;
    }, {});
  }).subscribe({
    next: (value) => set(value),
    error: (err) => console.error(err)
  });
  return () => subscription.unsubscribe();
});
const catalog = derived(
  [volumes$1],
  ([$volumes]) => deriveSeriesFromVolumes(Object.values($volumes))
);
const currentSeries = derived(
  [page, catalog],
  ([$page, $catalog]) => ($catalog.find((volume) => volume.series_uuid === $page.params.manga)?.volumes || []).sort(sortVolumes)
);
const currentVolume = derived([page, volumes$1], ([$page, $volumes]) => {
  if ($page && $volumes) {
    return $volumes[$page.params.volume];
  }
  return void 0;
});
const currentVolumeData = derived([currentVolume], ([$currentVolume], set) => {
  if ($currentVolume) {
    db.volumes_data.get($currentVolume.volume_uuid).then((data) => {
      if (data) {
        set(data);
      }
    });
  } else {
    set(void 0);
  }
});
class VolumeData {
  progress;
  chars;
  completed;
  timeReadInMinutes;
  settings;
  lastProgressUpdate;
  constructor(data = {}) {
    const volumeDefaults = {
      singlePageView: false,
      rightToLeft: true,
      hasCover: false
    };
    this.progress = typeof data.progress === "number" ? data.progress : 0;
    this.chars = typeof data.chars === "number" ? data.chars : 0;
    this.completed = !!data.completed;
    this.timeReadInMinutes = typeof data.timeReadInMinutes === "number" ? data.timeReadInMinutes : 0;
    this.lastProgressUpdate = data.lastProgressUpdate || new Date(this.progress).toISOString();
    this.settings = {
      singlePageView: typeof data.settings?.singlePageView === "boolean" ? data.settings.singlePageView : volumeDefaults.singlePageView,
      rightToLeft: typeof data.settings?.rightToLeft === "boolean" ? data.settings.rightToLeft : volumeDefaults.rightToLeft,
      hasCover: typeof data.settings?.hasCover === "boolean" ? data.settings.hasCover : volumeDefaults.hasCover
    };
  }
  static fromJSON(json) {
    if (typeof json === "string") {
      try {
        json = JSON.parse(json);
      } catch {
        json = {};
      }
    }
    return new VolumeData(json || {});
  }
  toJSON() {
    return {
      progress: this.progress,
      chars: this.chars,
      completed: this.completed,
      timeReadInMinutes: this.timeReadInMinutes,
      lastProgressUpdate: this.lastProgressUpdate,
      settings: { ...this.settings }
    };
  }
}
const initial = {};
const volumes = writable(initial);
function updateProgress(volume, progress2, chars, completed = false) {
  volumes.update((prev) => {
    const currentVolume2 = prev[volume] || new VolumeData();
    return {
      ...prev,
      [volume]: new VolumeData({
        ...currentVolume2,
        progress: progress2,
        chars: chars ?? currentVolume2.chars,
        completed,
        lastProgressUpdate: (/* @__PURE__ */ new Date()).toISOString()
      })
    };
  });
}
volumes.subscribe((volumes2) => {
});
const progress = derived(volumes, ($volumes) => {
  const progress2 = {};
  if ($volumes) {
    Object.keys($volumes).forEach((key) => {
      progress2[key] = $volumes[key].progress;
    });
  }
  return progress2;
});
const volumeSettings = derived(volumes, ($volumes) => {
  const settings2 = {};
  if ($volumes) {
    Object.keys($volumes).forEach((key) => {
      settings2[key] = $volumes[key].settings;
    });
  }
  return settings2;
});
const totalStats = derived([volumes, page], ([$volumes, $page]) => {
  if ($page && $volumes) {
    return Object.values($volumes).reduce((stats, { chars, completed, timeReadInMinutes, progress: progress2 }) => {
      if (completed) {
        stats.completed++;
      }
      stats.pagesRead += progress2;
      stats.minutesRead += timeReadInMinutes;
      stats.charsRead += chars;
      return stats;
    }, {
      charsRead: 0,
      completed: 0,
      pagesRead: 0,
      minutesRead: 0
    });
  }
});
const mangaStats = derived([currentSeries, volumes], ([$titleVolumes, $volumes]) => {
  if ($titleVolumes && $volumes) {
    return $titleVolumes.map((vol) => vol.volume_uuid).reduce(
      (stats, volumeId) => {
        const timeReadInMinutes = $volumes[volumeId]?.timeReadInMinutes || 0;
        const chars = $volumes[volumeId]?.chars || 0;
        const completed = $volumes[volumeId]?.completed || 0;
        stats.timeReadInMinutes = stats.timeReadInMinutes + timeReadInMinutes;
        stats.chars = stats.chars + chars;
        stats.completed = stats.completed + completed;
        return stats;
      },
      { timeReadInMinutes: 0, chars: 0, completed: 0 }
    );
  }
});
const volumeStats = derived([currentVolume, volumes], ([$currentVolume, $volumes]) => {
  if ($currentVolume && $volumes) {
    const { chars, completed, timeReadInMinutes, progress: progress2, lastProgressUpdate } = $volumes[$currentVolume.volume_uuid];
    return { chars, completed, timeReadInMinutes, progress: progress2, lastProgressUpdate };
  }
  return { chars: 0, completed: 0, timeReadInMinutes: 0, progress: 0, lastProgressUpdate: (/* @__PURE__ */ new Date(0)).toISOString() };
});
const defaultSettings$1 = {
  defaultFullscreen: false,
  displayOCR: true,
  textEditable: false,
  textBoxBorders: false,
  boldFont: false,
  pageNum: true,
  charCount: false,
  mobile: false,
  bounds: false,
  backgroundColor: "#030712",
  swipeThreshold: 50,
  edgeButtonWidth: 40,
  showTimer: false,
  quickActions: true,
  fontSize: "auto",
  zoomDefault: "zoomFitToScreen",
  invertColors: false,
  volumeDefaults: {
    singlePageView: false,
    rightToLeft: true,
    hasCover: false
  },
  ankiConnectSettings: {
    enabled: false,
    cropImage: false,
    grabSentence: false,
    overwriteImage: true,
    pictureField: "Picture",
    sentenceField: "Sentence",
    triggerMethod: "both"
  }
};
const defaultProfiles = {
  Default: defaultSettings$1
};
const initialProfiles = defaultProfiles;
const profiles = writable(initialProfiles);
const storedCurrentProfile = "Default";
const currentProfile = writable(storedCurrentProfile);
profiles.subscribe((profiles2) => {
});
currentProfile.subscribe((currentProfile2) => {
});
const settings = derived([profiles, currentProfile], ([profiles2, currentProfile2]) => {
  return profiles2[currentProfile2];
});
const defaultSettings = {
  galleryLayout: "grid",
  gallerySorting: "SMART"
};
const miscSettings = writable(defaultSettings);
miscSettings.subscribe((miscSettings2) => {
});
export {
  Button as B,
  volumes as a,
  mangaStats as b,
  catalog as c,
  currentSeries as d,
  currentVolumeData as e,
  currentVolume as f,
  volumeStats as g,
  volumeSettings as h,
  profiles as i,
  currentProfile as j,
  is_void as k,
  miscSettings as m,
  progress as p,
  settings as s,
  totalStats as t,
  updateProgress as u,
  volumes$1 as v
};
