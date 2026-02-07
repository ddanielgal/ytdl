/// <reference types="bun-types" />

declare module "*.html" {
  const value: string | Response;
  export default value;
}
