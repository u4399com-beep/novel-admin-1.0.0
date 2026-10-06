// tmpquery —— 一次性诊断查询（分页截断排查用），用后即删。输出 JSON 数组。
package main

import (
	"database/sql"
	"encoding/json"
	"fmt"
	"os"

	_ "modernc.org/sqlite"
)

func main() {
	db, err := sql.Open("sqlite", os.Args[1]+"?mode=ro")
	if err != nil {
		panic(err)
	}
	defer db.Close()

	rows, err := db.Query(os.Args[2])
	if err != nil {
		fmt.Println("QUERY ERR:", err)
		os.Exit(1)
	}
	defer rows.Close()
	cols, _ := rows.Columns()
	out := []map[string]any{}
	vals := make([]any, len(cols))
	ptrs := make([]any, len(cols))
	for i := range vals {
		ptrs[i] = &vals[i]
	}
	for rows.Next() {
		rows.Scan(ptrs...)
		row := map[string]any{}
		for i, c := range cols {
			v := vals[i]
			if b, ok := v.([]byte); ok {
				row[c] = string(b)
			} else {
				row[c] = v
			}
		}
		out = append(out, row)
	}
	json.NewEncoder(os.Stdout).Encode(out)
}
