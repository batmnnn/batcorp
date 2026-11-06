# The public, read-only FrameLab viewer. Built from a `git archive` of a commit, so only tracked
# files can reach the image. Published bundles are mounted read-only at /app/bundles at run time;
# none are baked in. No RUN steps, so a build on any host produces the same linux/amd64 image.
FROM oven/bun:1.3.14-slim@sha256:d56a2534ffd262e92c12fd3249d3924d296d97086da773f821d7d0477435ea04

WORKDIR /app
COPY LICENSE NOTICE ./
COPY viewer/index.html viewer/index.html
COPY rulepacks rulepacks
COPY src/ui/server.ts src/ui/hosted.ts src/ui/

USER bun
EXPOSE 8080
CMD ["bun", "src/ui/hosted.ts", "--port", "8080"]
