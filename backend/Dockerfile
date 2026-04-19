# Use a slim, stable Python base image
FROM python:3.11-slim

# Set the working directory inside the container
WORKDIR /app

# Copy dependencies first (takes advantage of Docker layer caching)
COPY requirements.txt .

# Install dependencies without storing cache to keep image small
RUN pip install --no-cache-dir -r requirements.txt

# Copy the rest of the backend source code
COPY . .

# We don't set a hardcoded CMD here because docker-compose 
# will specify whether to run app.py or worker.py