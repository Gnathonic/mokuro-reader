import { c as create_ssr_component, k as subscribe, v as validate_component, g as escape } from "../../../chunks/ssr.js";
import { p as page } from "../../../chunks/stores.js";
import { L as Loader } from "../../../chunks/Loader.js";
import "../../../chunks/db.js";
import "@zip.js/zip.js";
const Page = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  let $page, $$unsubscribe_page;
  $$unsubscribe_page = subscribe(page, (value) => $page = value);
  const BASE_URL = $page.url.searchParams.get("source") || "https://www.mokuro.moe/manga";
  $page.url.searchParams.get("manga");
  $page.url.searchParams.get("volume");
  let message = "Loading...";
  let completed = 0;
  let max = 0;
  if ($$props.BASE_URL === void 0 && $$bindings.BASE_URL && BASE_URL !== void 0)
    $$bindings.BASE_URL(BASE_URL);
  Math.floor(completed / max * 100).toString();
  $$unsubscribe_page();
  return `<div>${validate_component(Loader, "Loader").$$render($$result, {}, {}, {
    default: () => {
      return `${escape(message)} ${``}`;
    }
  })}</div>`;
});
export {
  Page as default
};
