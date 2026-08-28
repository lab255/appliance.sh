package main

import (
	"fmt"
	"log"
	"net/http"
)

func main() {
	http.HandleFunc("/healthz", func(writer http.ResponseWriter, _ *http.Request) {
		writer.WriteHeader(http.StatusNoContent)
	})
	http.HandleFunc("/", func(writer http.ResponseWriter, request *http.Request) {
		log.Printf("%s %s", request.Method, request.URL.Path)
		_, _ = fmt.Fprintln(writer, "notes-suite api")
	})
	log.Printf("listening on 0.0.0.0:9000")
	log.Fatal(http.ListenAndServe("0.0.0.0:9000", nil))
}
