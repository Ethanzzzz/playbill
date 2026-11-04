# 零依赖，可直接跑
FROM node:20-alpine

WORKDIR /app

# 只复制运行所需文件（不含个人数据）
COPY package.json ./
COPY server ./server
COPY web ./web

ENV PORT=8080
EXPOSE 8080

# 数据写到 /app/server/data.json；生产环境请挂载持久卷
CMD ["node", "server/index.mjs"]
