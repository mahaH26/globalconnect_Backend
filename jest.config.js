/** @type {import("jest").Config} **/
module.exports = {
  testEnvironment: "node",
  setupFiles: ["dotenv/config"],
  transform: {
    "^.+\\.(t|j)sx?$": ["@swc/jest"],
  },
};
