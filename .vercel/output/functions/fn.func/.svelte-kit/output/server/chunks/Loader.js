import { c as create_ssr_component, v as validate_component } from "./ssr.js";
import "./db.js";
import { S as Spinner } from "./Spinner.js";
const Loader = create_ssr_component(($$result, $$props, $$bindings, slots) => {
  return `<div class="flex flex-col gap-5 items-center justify-center h-full p-10">${validate_component(Spinner, "Spinner").$$render($$result, { size: "8" }, {}, {})} ${slots.default ? slots.default({}) : `Loading...`}</div>`;
});
export {
  Loader as L
};
