.DEFAULT_GOAL := run

PYTHON ?= python3
PORT ?= 5173
API_PORT ?= 18765
OPEN ?= 1
VENV := .venv
FRONTEND := apps/desktop

.PHONY: run install build test

run: install
	@$(VENV)/bin/python apps/desktop/run.py --port $(PORT) --api-port $(API_PORT) $(if $(filter 0,$(OPEN)),--no-open,)

install:
	@command -v $(PYTHON) >/dev/null || { echo "Install Python 3.12 or newer first."; exit 1; }
	@command -v npm >/dev/null || { echo "Install Node.js 22.12 or newer (includes npm) first."; exit 1; }
	@test -x $(VENV)/bin/python || $(PYTHON) -m venv $(VENV)
	@if [ ! -f $(VENV)/.requirements-installed ] || [ apps/vision/requirements.txt -nt $(VENV)/.requirements-installed ]; then \
		$(VENV)/bin/python -m pip install -r apps/vision/requirements.txt && touch $(VENV)/.requirements-installed; \
	fi
	@if [ ! -x $(FRONTEND)/node_modules/.bin/vite ] || [ ! -f $(FRONTEND)/node_modules/.installed ] || [ $(FRONTEND)/package-lock.json -nt $(FRONTEND)/node_modules/.installed ] || [ $(FRONTEND)/package.json -nt $(FRONTEND)/node_modules/.installed ]; then \
		npm --prefix $(FRONTEND) ci && touch $(FRONTEND)/node_modules/.installed; \
	fi
	@$(VENV)/bin/python -m apps.vision.face --download

build: install
	npm --prefix $(FRONTEND) run build

test: install
	$(VENV)/bin/python -m unittest discover -s tests -v
	npm --prefix $(FRONTEND) run build
