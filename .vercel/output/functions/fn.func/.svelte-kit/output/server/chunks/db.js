import Dexie from "dexie";
import { w as writable } from "./index.js";
const Thumbnail_svelte_svelte_type_style_lang = "";
const Indicator_svelte_svelte_type_style_lang = "";
async function generateThumbnail(file, maxWidth = 500, maxHeight = 700) {
  const canvas = document.createElement("canvas");
  const ctx = canvas.getContext("2d");
  if (!ctx)
    throw new Error("Could not get canvas context");
  const img = new Image();
  const imgUrl = URL.createObjectURL(file);
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = reject;
    img.src = imgUrl;
  });
  URL.revokeObjectURL(imgUrl);
  let width = img.width;
  let height = img.height;
  while (width > maxWidth * 2 || height > maxHeight * 2) {
    width = width / 2;
    height = height / 2;
  }
  width = Math.round(width);
  height = Math.round(height);
  canvas.width = width;
  canvas.height = height;
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = "high";
  ctx.drawImage(img, 0, 0, width, height);
  const blob = await new Promise((resolve) => canvas.toBlob((b) => resolve(b), file.type, 0.8));
  return new File([blob], `thumbnail_${file.name}`, { type: file.type });
}
function naturalSort(a, b) {
  return a.localeCompare(b, void 0, { numeric: true, sensitivity: "base" });
}
const isUpgrading = writable(false);
class CatalogDexie extends Dexie {
  volumes;
  volumes_data;
  catalog;
  constructor() {
    super("mokuro");
    this.version(1).stores({
      catalog: "id, manga"
    });
    this.version(2).stores({
      volumes_data: "volume_uuid",
      volumes: "volume_uuid",
      catalog: null
      // Remove old catalog table
    }).upgrade(async (tx) => {
      isUpgrading.set(true);
      const oldCatalog = await tx.table("catalog").toArray();
      const volumes = [];
      const volumes_data = [];
      for (const entry of oldCatalog) {
        for (const volume of entry.manga) {
          volumes.push({
            mokuro_version: volume.mokuroData.version,
            series_title: volume.mokuroData.title,
            series_uuid: volume.mokuroData.title_uuid,
            page_count: volume.mokuroData.pages.length,
            character_count: volume.mokuroData.chars,
            volume_title: volume.mokuroData.volume,
            volume_uuid: volume.mokuroData.volume_uuid
          });
          volumes_data.push({
            volume_uuid: volume.mokuroData.volume_uuid,
            pages: volume.mokuroData.pages,
            files: volume.files
          });
        }
      }
      await tx.table("volumes").bulkAdd(volumes);
      await tx.table("volumes_data").bulkAdd(volumes_data);
    });
    startThumbnailProcessing();
  }
  async processThumbnails(batchSize = 5) {
    const volumes = await this.volumes.filter((volume) => !volume.thumbnail).limit(batchSize).toArray();
    if (volumes.length === 0)
      return;
    await Promise.all(
      volumes.map(async (volume) => {
        db.volumes_data.get({ volume_uuid: volume.volume_uuid }).then(async (data) => {
          if (data && data.files) {
            try {
              const fileNames = Object.keys(data.files).sort(naturalSort);
              const firstImageFile = fileNames.length > 0 ? data.files[fileNames[0]] : null;
              if (firstImageFile) {
                const thumbnail = await generateThumbnail(firstImageFile);
                volume.thumbnail = thumbnail;
                await this.volumes.where("volume_uuid").equals(volume.volume_uuid).modify(volume);
              }
            } catch (error) {
              console.error("Failed to generate thumbnail for volume:", volume.volume_uuid, error);
            }
          }
        });
      })
    );
    await this.processThumbnails(batchSize);
  }
}
const db = new CatalogDexie();
function startThumbnailProcessing() {
  setTimeout(() => {
    db.processThumbnails().catch((error) => {
      console.error("Error in thumbnail processing:", error);
    });
  }, 1e3);
}
export {
  db as d,
  isUpgrading as i
};
