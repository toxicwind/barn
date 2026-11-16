#!/bin/bash
# Find mcpproxy references outside thresher/

rg -l 'mcpproxy' /home/toxic/pens/ 2>/dev/null | grep -v 'barn/products/thresher/' | grep -v 'barn/ssot/thresher/' | grep -v node_modules | grep -v '.git' | grep -v archive | grep -v '.meta.yaml' | grep -v '.meta-themes.yaml'
