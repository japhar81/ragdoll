# RAGdoll Python plugin service.
# Run targets from inside services/python-plugins/.

.PHONY: install lock serve test fmt

install:
	poetry install

lock:
	poetry lock

serve:
	poetry run uvicorn app.main:app --host $${HOST:-0.0.0.0} --port $${PORT:-8000}

test:
	poetry run pytest
