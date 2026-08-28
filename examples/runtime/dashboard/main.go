package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
)

func main() {
	listen := flag.String("listen", "0.0.0.0:8080", "HTTP listen address")
	exitCode := flag.Int("exit-code", -1, "exit immediately with this code")
	flag.Parse()
	if *exitCode >= 0 {
		os.Exit(*exitCode)
	}

	message := os.Getenv("DASHBOARD_MESSAGE")
	if message == "" {
		message = "dashboard binary runtime proof"
	}
	http.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		log.Printf("%s %s", request.Method, request.URL.Path)
		writer.Header().Set("Content-Type", "text/plain; charset=utf-8")
		_, _ = fmt.Fprintln(writer, message)
	})
	log.Printf("listening on %s", *listen)
	log.Fatal(http.ListenAndServe(*listen, nil))
}

