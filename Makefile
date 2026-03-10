HUB := $(shell dirname $(realpath $(lastword $(MAKEFILE_LIST))))/hub/bin/hub.mjs
REPO ?= $(shell pwd)
RUN_ID ?=
GOAL ?= Analiza este repo y propone plan
TOPIC ?= Brainstorm sobre arquitectura y riesgos
CHANNEL ?=
THREAD ?=

.PHONY: help hub-help profile-work profile-personal profile-current \
	run chat list status start approve reject stop stop-cleanup commit push pr pushpr \
	team-roles team-brainstorm team-provider-check team-add-role \
	slack-socket slack-notify slack-map-channels slack-map-list slack-map-set slack-map-remove slack-map-resolve

help:
	@echo "Frequent hub commands"
	@echo ""
	@echo "Profiles:"
	@echo "  make profile-work"
	@echo "  make profile-personal"
	@echo "  make profile-current"
	@echo ""
	@echo "Runs:"
	@echo "  make run GOAL=\"bug en auth sin tocar API\" REPO=/path/repo"
	@echo "  make status RUN_ID=<id>"
	@echo "  make start RUN_ID=<id>"
	@echo "  make approve RUN_ID=<id>"
	@echo "  make stop-cleanup RUN_ID=<id>"
	@echo "  make pushpr RUN_ID=<id>"
	@echo ""
	@echo "Team:"
	@echo "  make team-roles REPO=/path/repo"
	@echo "  make team-brainstorm REPO=/path/repo TOPIC=\"rediseño checkout\""
	@echo "  make team-provider-check REPO=/path/repo ROLE_ID=pm TOPIC=\"pregunta tecnica\""
	@echo "  make team-add-role REPO=/path/repo ROLE_ID=qa ROLE_NAME=\"QA Lead\" ROLE_PROVIDER=codex"
	@echo ""
	@echo "Slack:"
	@echo "  make slack-socket"
	@echo "  make slack-map-channels"
	@echo "  make slack-map-set CHANNEL=C123 REPO=/path/repo"
	@echo "  make slack-notify RUN_ID=<id> CHANNEL=C123"

hub-help:
	node $(HUB) --help

profile-work:
	node $(HUB) profile select work

profile-personal:
	node $(HUB) profile select personal

profile-current:
	node $(HUB) profile current

run:
	node $(HUB) run --repo "$(REPO)" "$(GOAL)"

chat:
	node $(HUB) chat --repo "$(REPO)"

list:
	node $(HUB) list

status:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) status "$(RUN_ID)"

start:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) start "$(RUN_ID)"

approve:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) approve "$(RUN_ID)"

reject:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) reject "$(RUN_ID)"

stop:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) stop "$(RUN_ID)"

stop-cleanup:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) stop "$(RUN_ID)" --cleanup

commit:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) commit "$(RUN_ID)"

push:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) push "$(RUN_ID)"

pr:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) pr "$(RUN_ID)"

pushpr:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
	node $(HUB) pushpr "$(RUN_ID)"

team-roles:
	node $(HUB) team roles --repo "$(REPO)"

team-brainstorm:
	node $(HUB) team brainstorm --repo "$(REPO)" "$(TOPIC)"

team-provider-check:
	node $(HUB) team provider-check --repo "$(REPO)" --role "$(ROLE_ID)" --topic "$(TOPIC)"

ROLE_ID ?= qa
ROLE_NAME ?= QA Lead
ROLE_PROVIDER ?= local-template
team-add-role:
	node $(HUB) team scaffold-role --repo "$(REPO)" --id "$(ROLE_ID)" --name "$(ROLE_NAME)" --provider "$(ROLE_PROVIDER)"

slack-socket:
	node $(HUB) slack socket

slack-notify:
	@test -n "$(RUN_ID)" || (echo "RUN_ID is required"; exit 1)
ifneq ($(strip $(CHANNEL)),)
	node $(HUB) slack notify "$(RUN_ID)" --channel "$(CHANNEL)"
else
	node $(HUB) slack notify "$(RUN_ID)"
endif

slack-map-channels:
	node $(HUB) slack map channels

slack-map-list:
	node $(HUB) slack map list

slack-map-set:
	@test -n "$(CHANNEL)" || (echo "CHANNEL is required"; exit 1)
	node $(HUB) slack map set --channel "$(CHANNEL)" --repo "$(REPO)"

slack-map-remove:
	@test -n "$(CHANNEL)" || (echo "CHANNEL is required"; exit 1)
	node $(HUB) slack map remove --channel "$(CHANNEL)"

slack-map-resolve:
	@test -n "$(CHANNEL)" || (echo "CHANNEL is required"; exit 1)
	node $(HUB) slack map resolve --channel "$(CHANNEL)"
