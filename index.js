"use strict";

import("./dist/index.mjs").catch((error) => {
  console.error(error);
  process.exit(1);
});
