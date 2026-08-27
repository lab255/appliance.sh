FROM golang:1.22-alpine AS build
WORKDIR /src
COPY go.mod main.go ./
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" -o /out/api .

FROM scratch
COPY --from=build /out/api /api
EXPOSE 9000
ENTRYPOINT ["/api"]
