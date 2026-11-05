# 零依赖，可直接跑
FROM node:20-alpine

WORKDIR /app

# 只复制运行所需文件（不含个人数据）
COPY package.json ./
COPY server ./server
COPY web ./web

ENV PORT=8080
# 数据目录独立于程序目录，挂载卷即可持久化
ENV PLAYBILL_DATA_DIR=/data
RUN mkdir -p /data

EXPOSE 8080

# 生产环境请挂载 /data 持久卷：docker run -v playbill-data:/data ...
CMD ["node", "server/index.mjs"]
