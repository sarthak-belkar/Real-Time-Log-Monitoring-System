from pymongo import MongoClient
import pymongo
import os
from dotenv import load_dotenv

def init_db():
    load_dotenv() 
    MONGO_URI = os.getenv("MONGO_URI", "mongodb://localhost:27017/")
    
    # Connect to MongoDB
    client = MongoClient(MONGO_URI, serverSelectionTimeoutMS=5000)
    db = client['log_system']
    logs_collection = db['logs']

    # Safely try to create indexes
    try:
        # Single & text indexes
        logs_collection.create_index([("timestamp", pymongo.DESCENDING)])

        logs_collection.create_index("level")
        logs_collection.create_index("service")
        logs_collection.create_index([("message", "text")]) 

        # Compound indexes for fast filtered sorting
        logs_collection.create_index([("service", pymongo.ASCENDING), ("timestamp", pymongo.DESCENDING)])
        logs_collection.create_index([("level", pymongo.ASCENDING), ("timestamp", pymongo.DESCENDING)])

        # 7-day TTL data retention policy
        logs_collection.create_index("created_at", expireAfterSeconds=7 * 24 * 3600)
        print("✅ MongoDB connected & indexes verified (including compound & TTL retention).")

    except Exception as e:
        print(f"⚠️ Warning: Could not verify MongoDB indexes right now. {e}")

    return logs_collection